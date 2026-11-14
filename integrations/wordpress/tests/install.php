<?php
/** Creates synthetic users/media only inside run.py's newly generated installation. */
$root = getenv('FRAMELEAF_FIXTURE_DIR');
if (!$root || !is_file($root . '/settings.json')) { throw new RuntimeException('Missing disposable fixture'); }
define('WP_INSTALLING', true);
require $root . '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
if (is_blog_installed()) { throw new RuntimeException('Refusing to modify an installed site'); }
$password = file_get_contents($root . '/admin-password');
wp_install('Frameleaf synthetic qualification', 'fixture-admin', 'synthetic@example.test', false, '', $password);
foreach (['editor', 'subscriber'] as $role) {
    $id = wp_create_user('fixture-' . $role, $password, $role . '@example.test');
    if (is_wp_error($id)) { throw new RuntimeException('Synthetic user setup failed'); }
    (new WP_User($id))->set_role($role);
}
$result = activate_plugin('frameleaf-connect/frameleaf-connect.php');
if (is_wp_error($result)) { throw new RuntimeException('Plugin activation failed'); }
update_option('frameleaf_connect_origins', [getenv('FRAMELEAF_FIXTURE_ORIGIN') => ['private' => true, 'client_id' => '']], false);
for ($version = 1; $version <= 2; $version++) {
    $image = imagecreatetruecolor(120, 80);
    imagefill($image, 0, 0, imagecolorallocate($image, $version === 1 ? 50 : 180, 80, 120));
    imagepng($image, $root . '/image' . $version . '.png');
}
echo "PASS disposable site, synthetic users and images installed\n";
