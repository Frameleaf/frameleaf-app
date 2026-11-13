<?php
/** Run inside the disposable WordPress installation with wp eval-file. */
function fc_assert($condition, $message) { if (!$condition) { throw new RuntimeException('FAIL ' . $message); } echo 'PASS ' . $message . "\n"; }
fc_assert(class_exists('Frameleaf_Connect_Store'), 'durable credential store is installed');
$store = new Frameleaf_Connect_Store();
$user = 40001;
$store->clear($user);
$first = $store->create($user, ['synthetic' => 'first']);
fc_assert($first['state'] === 'disconnected', 'new records deny authentication');
$winner = $store->change($first, 'pending', ['synthetic' => 'second']);
fc_assert($winner !== null, 'one worker claims transition');
fc_assert($store->change($first, 'pending', ['synthetic' => 'other']) === null, 'stale competing worker cannot overwrite');
fc_assert($store->read($user)['data']['synthetic'] === 'second', 'winner is durable');
global $wpdb;
$raw = $wpdb->get_var($wpdb->prepare("SELECT payload FROM {$wpdb->prefix}frameleaf_connect WHERE user_id=%d", $user));
fc_assert(!str_contains($raw, 'second'), 'database stores ciphertext only');
$store->clear($user);
fc_assert(class_exists('Frameleaf_Connect_OAuth'), 'OAuth controller is installed');
echo "Connection primitives passed\n";
$user = 40002;
$store->clear($user);
$record = $store->create($user, ['synthetic' => 'key-rotation']);
$other_vault = new Frameleaf_Connect_Security('retired-installation-key');
$wpdb->update($wpdb->prefix . 'frameleaf_connect', ['payload' => $other_vault->seal(['tokens' => ['refresh_token' => 'synthetic-only']], $wpdb->prefix . 'frameleaf_connect:' . $user)], ['user_id' => $user]);
try { $store->read($user); throw new RuntimeException('FAIL changed key accepted'); }
catch (RuntimeException $e) { fc_assert($e->getMessage() === 'reconnect', 'actual stored credentials fail closed after key rotation'); }
$store->clear($user);
