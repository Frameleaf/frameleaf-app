<?php
/**
 * Plugin Name: Frameleaf Connect
 * Description: Import authorized Frameleaf images into the WordPress Media Library.
 * Version: 0.1.0
 * Requires at least: 6.8
 * Requires PHP: 8.1
 * Author: Frameleaf
 * Author URI: https://frameleaf.app
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: frameleaf-connect
 * Domain Path: /languages
 */
if (!defined('ABSPATH')) { exit; }
require_once __DIR__ . '/includes/class-security.php';
require_once __DIR__ . '/includes/class-store.php';
register_activation_hook(__FILE__, ['Frameleaf_Connect_Store', 'install']);
require_once __DIR__ . '/includes/class-http.php';
require_once __DIR__ . '/includes/class-oauth.php';
require_once __DIR__ . '/includes/class-plugin.php';
Frameleaf_Connect_Plugin::boot();
require_once __DIR__ . '/includes/class-media.php';
register_activation_hook(__FILE__, ['Frameleaf_Connect_Media', 'install']);
add_action('init', static function () {
    load_plugin_textdomain('frameleaf-connect', false, dirname(plugin_basename(__FILE__)) . '/languages');
});
