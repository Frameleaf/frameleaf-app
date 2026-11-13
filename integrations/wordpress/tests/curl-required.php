<?php
/** Run with PHP -d disable_functions=curl_setopt_array in the disposable WordPress fixture. */
if (function_exists('curl_setopt_array')) { throw new RuntimeException('Run this test with curl_setopt_array disabled.'); }
try {
    Frameleaf_Connect_HTTP::request(getenv('FRAMELEAF_FIXTURE_ORIGIN') ?: 'https://localhost:39444', '/.well-known/oauth-authorization-server');
    throw new RuntimeException('FAIL missing pinning transport allowed');
} catch (RuntimeException $e) {
    if ($e->getMessage() !== 'curl_required') { throw $e; }
    if (Frameleaf_Connect_Plugin::error($e)->get_error_code() !== 'frameleaf_curl_required') { throw new RuntimeException('FAIL missing cURL requirement message'); }
    echo "PASS missing pinning transport fails closed with an actionable requirement\n";
}
