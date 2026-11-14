<?php
/** WordPress integration entry points. Secrets never enter browser responses. */
class Frameleaf_Connect_Plugin {
    public static function boot(): void {
        add_action('rest_api_init', [self::class, 'routes']);
        add_action('wp_enqueue_media', [self::class, 'media_assets']);
        add_action('admin_post_frameleaf_connect_callback', [self::class, 'callback']);
        add_action('admin_menu', static function () { add_media_page(__('Frameleaf', 'frameleaf-connect'), __('Frameleaf', 'frameleaf-connect'), 'upload_files', 'frameleaf-connect', [self::class, 'page']); });
    }

    public static function routes(): void {
        register_rest_route('frameleaf-connect/v1', '/connection', [
            'methods' => 'GET,POST,DELETE', 'permission_callback' => static fn() => current_user_can('upload_files'),
            'callback' => static function (WP_REST_Request $request) {
                try {
                    $oauth = new Frameleaf_Connect_OAuth();
                    if ($request->get_method() === 'POST' && $request->get_param('resetAfterKeyChange') === true) {
                        if ($request->get_param('revokedInFrameleaf') !== true) { throw new RuntimeException('forbidden'); }
                        $oauth->reset_after_key_change();
                        return new WP_REST_Response(['state' => 'disconnected'], 200, ['Cache-Control' => 'no-store']);
                    }
                    if ($request->get_method() === 'POST') {
                        $origin = $request->get_param('origin');
                        if (!is_string($origin)) { throw new RuntimeException('invalid_origin'); }
                        return new WP_REST_Response(['authorizeUrl' => $oauth->start($origin)], 200, ['Cache-Control' => 'no-store']);
                    }
                    if ($request->get_method() === 'DELETE') { $oauth->disconnect(); }
                    return new WP_REST_Response(['state' => $oauth->status()], 200, ['Cache-Control' => 'no-store']);
                } catch (Throwable $e) { return self::error($e); }
            },
        ]);
        foreach (['albums', 'assets', 'preview', 'import'] as $operation) {
            register_rest_route('frameleaf-connect/v1', '/' . $operation, [
                'methods' => $operation === 'import' ? 'POST' : 'GET',
                'permission_callback' => static fn() => current_user_can('upload_files'),
                'callback' => static function (WP_REST_Request $request) use ($operation) {
                    try {
                        $media = new Frameleaf_Connect_Media();
                        if ($operation === 'albums') { $result = $media->albums(); }
                        elseif ($operation === 'assets') { $result = $media->assets(sanitize_text_field($request->get_param('q') ?? ''), sanitize_text_field($request->get_param('album') ?? ''), (int) ($request->get_param('page') ?? 1)); }
                        else {
                            $id = $request->get_param('id');
                            if (!is_string($id)) { throw new RuntimeException('invalid_asset'); }
                            if ($operation === 'import' && $request->get_param('copyAcknowledged') !== true) { throw new RuntimeException('copy_consent_required'); }
                            $result = $operation === 'import' ? $media->import($id) : $media->preview($id);
                        }
                        return new WP_REST_Response($result, 200, ['Cache-Control' => 'no-store']);
                    } catch (Throwable $e) { return self::error($e); }
                },
            ]);
        }
    }

    public static function media_assets(): void {
        if (!current_user_can('upload_files')) { return; }
        wp_enqueue_script('frameleaf-connect-media', plugins_url('../assets/media.js', __FILE__), ['media-views', 'wp-api-fetch'], '0.1.0', true);
        wp_enqueue_style('frameleaf-connect-media', plugins_url('../assets/media.css', __FILE__), [], '0.1.0');
        wp_localize_script('frameleaf-connect-media', 'frameleafMedia', [
            'title' => __('Frameleaf', 'frameleaf-connect'), 'albums' => __('All selected albums', 'frameleaf-connect'),
            'search' => __('Search images', 'frameleaf-connect'), 'import' => __('Import image', 'frameleaf-connect'),
            'previous' => __('Previous', 'frameleaf-connect'), 'next' => __('Next', 'frameleaf-connect'),
            'loading' => __('Loading…', 'frameleaf-connect'), 'empty' => __('No images are available in your selected albums.', 'frameleaf-connect'),
            'failed' => __('Frameleaf could not complete the request. Check your connection or reconnect.', 'frameleaf-connect'),
            'copy' => __('Imported images are copied into WordPress. They remain here after disconnecting or revoking Frameleaf access.', 'frameleaf-connect'),
            'confirm' => __('I understand that imported images become WordPress attachments.', 'frameleaf-connect'),
            'connect' => __('Connect Frameleaf', 'frameleaf-connect'), 'settings' => admin_url('upload.php?page=frameleaf-connect'),
            'image' => __('Frameleaf image', 'frameleaf-connect'),
        ]);
    }

    public static function error(Throwable $e): WP_Error {
        $known = ['forbidden', 'invalid_origin', 'origin_not_allowed', 'invalid_callback', 'https_callback_required', 'client_id_required', 'disconnect_first', 'connection_busy', 'reconnect', 'access_denied', 'rate_limited', 'import_busy'];
        $code = in_array($e->getMessage(), $known, true) ? $e->getMessage() : 'connection_failed';
        $status = $code === 'forbidden' ? 403 : ($code === 'connection_busy' ? 503 : ($code === 'rate_limited' ? 429 : ($code === 'import_busy' ? 409 : 400)));
        if ($e->getMessage() === 'curl_required') { return new WP_Error('frameleaf_curl_required', __('Frameleaf requires PHP cURL with HTTPS support and a direct network route to the Library. HTTP proxies are not used for Library requests.', 'frameleaf-connect'), ['status' => 503]); }
        return new WP_Error('frameleaf_' . $code, __('Frameleaf could not complete the request. Check your connection or reconnect.', 'frameleaf-connect'), ['status' => $status]);
    }

    // phpcs:disable WordPress.Security.NonceVerification.Recommended -- complete() verifies stored WordPress nonce, OAuth state, current user and current login session before exchange.
    public static function callback(): void {
        try {
            $state = isset($_GET['state']) && is_string($_GET['state']) ? sanitize_text_field(wp_unslash($_GET['state'])) : '';
            $code = isset($_GET['code']) && is_string($_GET['code']) ? sanitize_text_field(wp_unslash($_GET['code'])) : '';
            (new Frameleaf_Connect_OAuth())->complete($state, $code, isset($_GET['error']));
            wp_safe_redirect(admin_url('upload.php?page=frameleaf-connect'));
            exit;
        } catch (Throwable $e) {
            wp_die(esc_html(self::error($e)->get_error_message()), esc_html__('Frameleaf', 'frameleaf-connect'), ['response' => 400]);
        }
    }

    // phpcs:enable WordPress.Security.NonceVerification.Recommended

    public static function page(): void {
        if (!current_user_can('upload_files')) { return; }
        if (isset($_POST['frameleaf_origins']) && current_user_can('manage_options')) {
            check_admin_referer('frameleaf_connect_settings');
            try {
                $origin = Frameleaf_Connect_Security::origin(sanitize_text_field(wp_unslash($_POST['frameleaf_origin'] ?? '')));
                $client = sanitize_text_field(wp_unslash($_POST['frameleaf_client'] ?? ''));
                if (strlen($client) > 200) { throw new RuntimeException('invalid_client'); }
                $all = get_option('frameleaf_connect_origins', []);
                if (isset($_POST['frameleaf_remove'])) { unset($all[$origin]); }
                else { $all[$origin] = ['client_id' => $client, 'private' => !empty($_POST['frameleaf_private'])]; }
                update_option('frameleaf_connect_origins', $all, false);
            } catch (Throwable $e) { echo '<div class="notice notice-error"><p>' . esc_html__('Enter a valid HTTPS Library origin without a path.', 'frameleaf-connect') . '</p></div>'; }
        }
        $origins = get_option('frameleaf_connect_origins', []);
        echo '<div class="wrap"><h1>' . esc_html__('Frameleaf', 'frameleaf-connect') . '</h1>';
        echo '<p>' . esc_html__('Frameleaf requires PHP cURL with HTTPS support and a direct network route to the Library. HTTP proxies are not used for Library requests.', 'frameleaf-connect') . '</p>';
        echo '<p>' . esc_html__('Connect your own Frameleaf account and choose the albums WordPress may read.', 'frameleaf-connect') . '</p>';
        echo '<p>' . esc_html__('Imported images are copied into WordPress. They remain here after disconnecting or revoking Frameleaf access.', 'frameleaf-connect') . '</p>';
        echo '<p><label><input type="checkbox" id="frameleaf-revoked"> ' . esc_html__('I revoked WordPress access in Frameleaf.', 'frameleaf-connect') . '</label> <button type="button" class="button" id="frameleaf-reset">' . esc_html__('Reset after a WordPress key change', 'frameleaf-connect') . '</button></p>';
        echo '<label for="frameleaf-origin">' . esc_html__('Library', 'frameleaf-connect') . '</label> <select id="frameleaf-origin">';
        foreach ($origins as $origin => $config) { echo '<option value="' . esc_attr($origin) . '">' . esc_html($origin) . '</option>'; }
        echo '</select> <button type="button" class="button button-primary" id="frameleaf-connect">' . esc_html__('Connect Frameleaf', 'frameleaf-connect') . '</button> <button type="button" class="button" id="frameleaf-disconnect">' . esc_html__('Disconnect', 'frameleaf-connect') . '</button><p id="frameleaf-status" role="status" aria-live="polite"></p>';
        if (current_user_can('manage_options')) {
            echo '<h2>' . esc_html__('Allowed Libraries', 'frameleaf-connect') . '</h2><p>' . esc_html__('Add each Library your editors may connect to. Allow private networking only for a Library you administer.', 'frameleaf-connect') . '</p>';
            echo '<p>' . esc_html__('Register this exact callback in Frameleaf Connect when automatic registration is disabled:', 'frameleaf-connect') . ' <code>' . esc_html(admin_url('admin-post.php?action=frameleaf_connect_callback')) . '</code></p><form method="post">';
            wp_nonce_field('frameleaf_connect_settings');
            echo '<input type="hidden" name="frameleaf_origins" value="1"><p><label>' . esc_html__('Library HTTPS origin', 'frameleaf-connect') . ' <input type="url" name="frameleaf_origin" required class="regular-text" placeholder="https://photos.example.com"></label></p><p><label>' . esc_html__('Client ID (leave empty for automatic registration)', 'frameleaf-connect') . ' <input type="text" name="frameleaf_client" class="regular-text"></label></p><p><label><input type="checkbox" name="frameleaf_private"> ' . esc_html__('Allow this Library on a private network', 'frameleaf-connect') . '</label></p>';
            submit_button(__('Save Library', 'frameleaf-connect'), 'secondary', 'frameleaf_save', false);
            echo ' ';
            submit_button(__('Remove Library', 'frameleaf-connect'), 'secondary', 'frameleaf_remove', false);
            echo '</form>';
        }
        echo '</div>';
        wp_enqueue_script('frameleaf-connect-settings', plugins_url('../assets/settings.js', __FILE__), ['wp-api-fetch'], '0.1.0', true);
        wp_localize_script('frameleaf-connect-settings', 'frameleafConnect', ['connected' => __('Connected', 'frameleaf-connect'), 'disconnected' => __('Disconnected', 'frameleaf-connect'), 'reconnect' => __('Reconnect required. Disconnect first; if revocation fails, retry. After a WordPress key change, revoke access in Frameleaf and confirm revocation here before resetting this connection.', 'frameleaf-connect'), 'failed' => __('Frameleaf could not complete the request. Check your connection or reconnect.', 'frameleaf-connect')]);
    }
}
