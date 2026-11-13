<?php
// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Durable CAS and unique import receipts must read live database state.
/** Durable compare-and-swap store: never expire a refresh lease and reuse its token. */
class Frameleaf_Connect_Store {
    private $db;
    private string $table;
    private Frameleaf_Connect_Security $vault;

    public function __construct() {
        global $wpdb;
        $this->db = $wpdb;
        $this->table = $wpdb->prefix . 'frameleaf_connect';
        $this->vault = new Frameleaf_Connect_Security(wp_salt('auth') . wp_salt('secure_auth') . wp_salt('logged_in') . wp_salt('nonce'));
    }

    public static function install(): void {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $table = $wpdb->prefix . 'frameleaf_connect';
        dbDelta("CREATE TABLE $table (
            user_id bigint(20) unsigned NOT NULL,
            revision bigint(20) unsigned NOT NULL DEFAULT 1,
            state varchar(24) NOT NULL,
            payload longtext NOT NULL,
            updated bigint(20) unsigned NOT NULL,
            PRIMARY KEY  (user_id)
        ) {$wpdb->get_charset_collate()};");
    }

    private function context(int $user): string { return $this->table . ':' . $user; }

    public function read(int $user): ?array {
        $row = $this->db->get_row($this->db->prepare("SELECT * FROM %i WHERE user_id=%d", $this->table, $user), ARRAY_A);
        if ($this->db->last_error) { throw new RuntimeException('storage_unavailable'); }
        if (!$row) { return null; }
        $row['user_id'] = (int) $row['user_id'];
        $row['revision'] = (int) $row['revision'];
        $row['updated'] = (int) $row['updated'];
        $row['data'] = $this->vault->open($row['payload'], $this->context($user));
        unset($row['payload']);
        return $row;
    }

    public function create(int $user, array $data = []): array {
        $payload = $this->vault->seal($data, $this->context($user));
        $result = $this->db->query($this->db->prepare("INSERT IGNORE INTO %i (user_id,revision,state,payload,updated) VALUES (%d,1,'disconnected',%s,%d)", $this->table, $user, $payload, time()));
        if ($result === false) { throw new RuntimeException('storage_unavailable'); }
        return $this->read($user);
    }

    public function change(array $before, string $state, array $data): ?array {
        $payload = $this->vault->seal($data, $this->context($before['user_id']));
        $result = $this->db->query($this->db->prepare("UPDATE %i SET revision=revision+1,state=%s,payload=%s,updated=%d WHERE user_id=%d AND revision=%d AND state=%s", $this->table, $state, $payload, time(), $before['user_id'], $before['revision'], $before['state']));
        if ($result === false) { throw new RuntimeException('storage_unavailable'); }
        if ($result !== 1) { return null; }
        return ['user_id' => $before['user_id'], 'revision' => $before['revision'] + 1, 'state' => $state, 'data' => $data, 'updated' => time()];
    }

    /** Used only after successful revocation or an explicit local reset after salt rotation. */
    public function clear(int $user): void {
        if ($this->db->delete($this->table, ['user_id' => $user], ['%d']) === false) { throw new RuntimeException('storage_unavailable'); }
    }
}
