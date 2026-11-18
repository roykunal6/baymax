<?php
// Copy this file to config.php (which is git-ignored) and fill in your values.
// You can also set ANTHROPIC_API_KEY as a server environment variable instead.
return [
    // Your Anthropic API key from https://platform.claude.com/settings/keys
    'anthropic_api_key' => '',

    // A PIN the app must send (Settings → AI mode → Access PIN). Required: stops strangers spending your credits.
    'pin' => 'change-me',

    'model' => 'claude-opus-5-5',

    // Max AI requests per IP per minute.
    'rate_limit_per_minute' => 20,
];
