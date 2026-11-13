<?php
// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Durable CAS and unique import receipts must read live database state.
/** Authorized, bounded rendition copies through WordPress's native attachment pipeline. */
class Frameleaf_Connect_Media {
    public static function install(): void {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $table = $wpdb->prefix . 'frameleaf_imports';
        dbDelta("CREATE TABLE $table (
            import_key varchar(64) NOT NULL,
            operation varchar(64) NOT NULL,
            attachment_id bigint(20) unsigned NOT NULL DEFAULT 0,
            created bigint(20) unsigned NOT NULL,
            PRIMARY KEY  (import_key)
        ) {$wpdb->get_charset_collate()};");
    }

    private function connection(): array { return (new Frameleaf_Connect_OAuth())->access(); }
    private function id(string $id): string {
        if (!preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/Di', $id)) { throw new RuntimeException('invalid_asset'); }
        return strtolower($id);
    }
    private function read(array $connection, string $path): array {
        return Frameleaf_Connect_HTTP::json($connection['origin'], '/api/connect/' . $path, ['headers' => ['Authorization' => 'Bearer ' . $connection['tokens']['access_token']]]);
    }
    public function albums(): array {
        $data = $this->read($this->connection(), 'albums');
        return ['items' => array_values(array_filter($data['items'] ?? [], static fn($album) => !empty($album['canRead'])))];
    }
    public function assets(string $query = '', string $album = '', int $page = 1): array {
        $params = ['type' => 'IMAGE', 'size' => 40, 'page' => max(1, min(100000, $page)), 'q' => mb_substr($query, 0, 200)];
        if ($album) { $params['albumId'] = $this->id($album); }
        return $this->read($this->connection(), 'assets?' . http_build_query($params));
    }
    private function image(string $bytes): string {
        $size = @getimagesizefromstring($bytes);
        if (!$size || !in_array($size['mime'], ['image/jpeg', 'image/png', 'image/webp'], true) || $size[0] * $size[1] > 40000000) { throw new RuntimeException('unsupported_image'); }
        return $size['mime'];
    }
    public function preview(string $id): array {
        $id = $this->id($id);
        $connection = $this->connection();
        $response = Frameleaf_Connect_HTTP::request($connection['origin'], '/api/connect/assets/' . $id . '/rendition?variant=thumbnail', ['headers' => ['Authorization' => 'Bearer ' . $connection['tokens']['access_token']]], 2097153);
        $bytes = wp_remote_retrieve_body($response);
        if (strlen($bytes) > 2097152) { throw new RuntimeException('image_too_large'); }
        return ['data' => 'data:' . $this->image($bytes) . ';base64,' . base64_encode($bytes)];
    }

    public function import(string $id): array {
        global $wpdb;
        $id = $this->id($id);
        $connection = $this->connection();
        $asset = $this->read($connection, 'assets/' . $id);
        if (($asset['id'] ?? null) !== $id || ($asset['type'] ?? '') !== 'IMAGE') { throw new RuntimeException('unsupported_image'); }
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';
        require_once ABSPATH . 'wp-admin/includes/media.php';
        $temp = wp_tempnam('frameleaf');
        if (!$temp) { throw new RuntimeException('storage_unavailable'); }
        $moved = null;
        $attachment = 0;
        $claimed = false;
        $committing = false;
        $key = '';
        $operation = Frameleaf_Connect_Security::random();
        $table = $wpdb->prefix . 'frameleaf_imports';
        try {
            $limit = min(16777216, wp_max_upload_size());
            Frameleaf_Connect_HTTP::request($connection['origin'], '/api/connect/assets/' . $id . '/rendition?variant=preview', [
                'headers' => ['Authorization' => 'Bearer ' . $connection['tokens']['access_token']],
                'stream' => true, 'filename' => $temp,
            ], $limit + 1);
            $length = filesize($temp);
            if (!$length || $length > $limit) { throw new RuntimeException('image_too_large'); }
            $bytes = file_get_contents($temp);
            $mime = $this->image($bytes);
            unset($bytes);
            $hash = hash_file('sha256', $temp);
            $key = hash('sha256', wp_json_encode([$connection['server_id'], $id, $hash, 'preview']));
            $result = $wpdb->query($wpdb->prepare("INSERT IGNORE INTO %i (import_key,operation,attachment_id,created) VALUES (%s,%s,0,%d)", $table, $key, $operation, time()));
            if ($result === false) { throw new RuntimeException('storage_unavailable'); }
            if ($result === 0) {
                $existing = $wpdb->get_row($wpdb->prepare("SELECT attachment_id FROM %i WHERE import_key=%s", $table, $key), ARRAY_A);
                $existing_id = (int) ($existing['attachment_id'] ?? 0);
                if (!$existing_id) { throw new RuntimeException('import_busy'); }
                if (get_post_type($existing_id) !== 'attachment' || !is_file(get_attached_file($existing_id))) {
                    // Recreate a deleted local copy without re-downloading or racing another importer.
                    $wpdb->query($wpdb->prepare("DELETE FROM %i WHERE import_key=%s AND attachment_id=%d", $table, $key, $existing_id));
                    $result = $wpdb->query($wpdb->prepare("INSERT IGNORE INTO %i (import_key,operation,attachment_id,created) VALUES (%s,%s,0,%d)", $table, $key, $operation, time()));
                    if ($result !== 1) { throw new RuntimeException('import_busy'); }
                } else {
                    if (!current_user_can('read_post', $existing_id)) { throw new RuntimeException('forbidden'); }
                    return wp_prepare_attachment_for_js($existing_id);
                }
            }
            $claimed = true;
            $extension = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'][$mime];
            $filename = 'frameleaf-' . $id . '-' . substr($hash, 0, 16) . '.' . $extension;
            $file = ['name' => $filename, 'tmp_name' => $temp, 'type' => $mime, 'size' => $length, 'error' => 0];
            $upload = wp_handle_sideload($file, ['test_form' => false, 'mimes' => ['jpg|jpeg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp']]);
            if (isset($upload['error'])) { throw new RuntimeException('storage_unavailable'); }
            $moved = $upload['file'];
            $insert = wp_insert_attachment([
                'post_mime_type' => $mime, 'post_title' => sanitize_text_field($asset['title'] ?: __('Frameleaf image', 'frameleaf-connect')),
                'post_excerpt' => sanitize_textarea_field($asset['description'] ?? ''), 'post_status' => 'inherit',
                'post_author' => get_current_user_id(), 'guid' => $upload['url'],
            ], $moved, 0, true);
            if (is_wp_error($insert)) { throw new RuntimeException('storage_unavailable'); }
            $attachment = $insert;
            $metadata = wp_generate_attachment_metadata($attachment, $moved);
            if (!is_array($metadata) || empty($metadata['width']) || empty($metadata['height'])) { throw new RuntimeException('storage_unavailable'); }
            wp_update_attachment_metadata($attachment, $metadata);
            update_post_meta($attachment, '_frameleaf_content_sha256', $hash);
            update_post_meta($attachment, '_frameleaf_import_key', $key);
            $committing = true;
            $saved = $wpdb->query($wpdb->prepare("UPDATE %i SET attachment_id=%d WHERE import_key=%s AND operation=%s AND attachment_id=0", $table, $attachment, $key, $operation));
            if ($saved !== 1) { throw new RuntimeException('import_uncertain'); }
            return wp_prepare_attachment_for_js($attachment);
        } finally {
            if (is_file($temp)) { wp_delete_file($temp); }
            // Do not erase a publication after an uncertain receipt write. Its durable claim blocks duplicate retries.
            if ($claimed && !$committing) {
                if ($attachment) { wp_delete_attachment($attachment, true); }
                elseif ($moved && is_file($moved)) { wp_delete_file($moved); }
                $wpdb->query($wpdb->prepare("DELETE FROM %i WHERE import_key=%s AND operation=%s AND attachment_id=0", $table, $key, $operation));
            }
        }
    }
}
