<?php
/**
 * Optional AI endpoint for the voice assistant.
 *
 * POST JSON { text, now, tasks[], routines[], history[] } with header X-Assistant-Pin.
 * Returns JSON { reply, actions[] } where each action has the same shape the
 * browser's offline parser produces, so the app runs them with one executor.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function respond(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, ['error' => 'POST only']);
}

$configFile = __DIR__ . '/config.php';
$config = is_file($configFile) ? require $configFile : [];
$apiKey = ($config['anthropic_api_key'] ?? '') ?: (getenv('ANTHROPIC_API_KEY') ?: '');
$pin = (string) ($config['pin'] ?? '');
$model = (string) ($config['model'] ?? 'claude-opus-5-5');
$perMinute = (int) ($config['rate_limit_per_minute'] ?? 20);

if ($apiKey === '') {
    respond(503, ['error' => 'AI is not configured on the server (missing API key)']);
}
if ($pin === '' || $pin === 'change-me') {
    respond(503, ['error' => 'Set a PIN in api/config.php before enabling AI mode']);
}
if (!hash_equals($pin, (string) ($_SERVER['HTTP_X_ASSISTANT_PIN'] ?? ''))) {
    respond(401, ['error' => 'Wrong PIN']);
}

// --- Simple per-IP rate limit (file based, no database needed) ---
$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$bucket = sys_get_temp_dir() . '/va-rl-' . hash('sha256', $ip);
$now = time();
$hits = array_filter(
    is_file($bucket) ? (array) json_decode((string) file_get_contents($bucket), true) : [],
    static fn ($t) => is_int($t) && $t > $now - 60,
);
if (count($hits) >= $perMinute) {
    respond(429, ['error' => 'Too many requests, slow down a little']);
}
$hits[] = $now;
@file_put_contents($bucket, json_encode(array_values($hits)), LOCK_EX);

// --- Input ---
$input = json_decode((string) file_get_contents('php://input'), true);
$text = trim((string) ($input['text'] ?? ''));
if ($text === '' || mb_strlen($text) > 1000) {
    respond(400, ['error' => 'Say something between 1 and 1000 characters']);
}
$clientNow = substr((string) ($input['now'] ?? date(DATE_RFC2822)), 0, 100);
$tasks = array_slice(is_array($input['tasks'] ?? null) ? $input['tasks'] : [], 0, 30);
$routines = array_slice(is_array($input['routines'] ?? null) ? $input['routines'] : [], 0, 30);
$history = array_slice(is_array($input['history'] ?? null) ? $input['history'] : [], -6);

require __DIR__ . '/vendor/autoload.php';

use Anthropic\Client;

const ACTION_TYPES = [
    'add_task', 'remind', 'timer', 'add_note', 'list_tasks', 'list_notes', 'complete_task',
    'delete_task', 'open', 'search', 'email', 'briefing', 'run_routine', 'time', 'date',
];

$system = <<<PROMPT
You are Baymax, the brain of a voice-controlled personal assistant app. The user spoke a command that the app's
simple built-in parser did not understand. Turn it into actions the app can run, and a short spoken reply.

Action types and their fields:
- add_task {title, due?}            due is an ISO 8601 datetime with the user's UTC offset, or omitted
- remind {title, due}               always include due; pick a sensible time if the user was vague
- timer {seconds}
- add_note {text}
- list_tasks {filter: "open"|"today"|"overdue"}
- list_notes {}
- complete_task {query}             query = words that identify an existing task
- delete_task {query}
- open {url}                        full https URL
- search {query}
- email {to, subject, body}         opens a pre-filled draft; the user sends it themselves
- briefing {}                       summary of the user's day
- run_routine {name}                must exactly match one of the user's routine names
- time {} / date {}

Rules:
- The reply is spoken aloud: one or two short, friendly sentences, no markdown, no lists.
- Do not repeat in the reply what an action will already say (e.g. "Added X" is said by add_task).
  If actions cover everything, the reply can be an empty string.
- A request may need several actions; return them in order. If nothing fits, return no actions and
  answer helpfully in the reply (general questions are fine, keep it brief).
- Never invent email addresses or URLs the user did not give, except well-known public websites.
PROMPT;

$context = "Current local date/time for the user: {$clientNow}\n"
    . 'Open tasks: ' . json_encode($tasks, JSON_UNESCAPED_UNICODE) . "\n"
    . 'Routine names: ' . json_encode($routines, JSON_UNESCAPED_UNICODE) . "\n"
    . 'Recent conversation: ' . json_encode($history, JSON_UNESCAPED_UNICODE) . "\n\n"
    . "Command: {$text}";

$schema = [
    'type' => 'object',
    'properties' => [
        'reply' => ['type' => 'string'],
        'actions' => [
            'type' => 'array',
            'items' => [
                'type' => 'object',
                'properties' => [
                    'type' => ['type' => 'string', 'enum' => ACTION_TYPES],
                    'title' => ['type' => 'string'],
                    'due' => ['type' => 'string'],
                    'text' => ['type' => 'string'],
                    'seconds' => ['type' => 'integer'],
                    'filter' => ['type' => 'string', 'enum' => ['open', 'today', 'overdue']],
                    'query' => ['type' => 'string'],
                    'url' => ['type' => 'string'],
                    'to' => ['type' => 'string'],
                    'subject' => ['type' => 'string'],
                    'body' => ['type' => 'string'],
                    'name' => ['type' => 'string'],
                ],
                'required' => ['type'],
                'additionalProperties' => false,
            ],
        ],
    ],
    'required' => ['reply', 'actions'],
    'additionalProperties' => false,
];

try {
    $client = new Client(apiKey: $apiKey);
    $message = $client->beta->messages->create(
        model: $model,
        maxTokens: 4000,
        system: $system,
        messages: [['role' => 'user', 'content' => $context]],
        outputConfig: [
            'effort' => 'low',
            'format' => ['type' => 'json_schema', 'schema' => $schema],
        ],
        // If the model declines for policy reasons, let the API retry on its default fallback model.
        fallbacks: 'default',
        betas: ['server-side-fallback-2026-07-01'],
    );
} catch (\Anthropic\Core\Exceptions\RateLimitException $e) {
    respond(429, ['error' => 'The AI service is busy, try again in a moment']);
} catch (\Anthropic\Core\Exceptions\AuthenticationException $e) {
    respond(502, ['error' => 'The server’s API key was rejected']);
} catch (\Anthropic\Core\Exceptions\APIStatusException $e) {
    error_log('assistant.php API error: ' . $e->getMessage());
    respond(502, ['error' => 'The AI service returned an error']);
} catch (\Anthropic\Core\Exceptions\APIConnectionException $e) {
    respond(504, ['error' => 'Could not reach the AI service']);
}

if ($message->stopReason === 'refusal') {
    respond(200, ['reply' => 'Sorry, I can’t help with that one.', 'actions' => []]);
}

$data = null;
foreach ($message->content as $block) {
    if ($block->type === 'text') {
        $data = json_decode($block->text, true);
        break;
    }
}
if (!is_array($data)) {
    respond(502, ['error' => 'The AI returned an unreadable answer']);
}

// Defence in depth: keep only known action types and safe URLs.
$actions = [];
foreach (array_slice((array) ($data['actions'] ?? []), 0, 10) as $a) {
    if (!is_array($a) || !in_array($a['type'] ?? '', ACTION_TYPES, true)) {
        continue;
    }
    if ($a['type'] === 'open' && !preg_match('#^https://#i', (string) ($a['url'] ?? ''))) {
        continue;
    }
    $actions[] = $a;
}

respond(200, ['reply' => (string) ($data['reply'] ?? ''), 'actions' => $actions]);
