<?php
/** Installed only in the generated disposable WordPress installation, never in the plugin ZIP. */
add_filter('pre_wp_mail', static fn() => true);
add_filter('http_request_args', static function ($args, $url) {
    $origin = getenv('FRAMELEAF_FIXTURE_ORIGIN');
    if ($origin && str_starts_with($url, $origin . '/')) {
        $args['sslcertificates'] = getenv('FRAMELEAF_FIXTURE_DIR') . '/certs/ca.pem';
    }
    return $args;
}, 10, 2);
add_action('rest_api_init', static function () {
    register_rest_route('frameleaf-fixture/v1', '/refresh', [
        'methods' => 'POST',
        'permission_callback' => static fn() => current_user_can('upload_files'),
        'callback' => static function () {
            try {
                (new Frameleaf_Connect_OAuth())->access();
                return ['ok' => true];
            } catch (Throwable $e) {
                return new WP_Error('fixture_connection', 'Synthetic connection failed', ['status' => 400]);
            }
        },
    ]);
});
