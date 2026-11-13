<?php
/** Real WordPress HTTP transport tests against the task-only HTTPS provider. */
function fh_assert($condition,$label){if(!$condition)throw new RuntimeException('FAIL '.$label);echo 'PASS '.$label."\n";}
$origin=getenv('FRAMELEAF_FIXTURE_ORIGIN') ?: 'https://localhost:39444';
try{Frameleaf_Connect_HTTP::json('https://unauthorized.example.test','/api/connect/capabilities');throw new RuntimeException('unexpected');}catch(RuntimeException $e){fh_assert($e->getMessage()==='origin_not_allowed','unknown origin rejected before network');}
foreach(['/api/connect/../oauth/apps/token','https://example.test/api/connect','/api/connect//assets'] as $path){try{Frameleaf_Connect_HTTP::json($origin,$path);throw new RuntimeException('unexpected');}catch(RuntimeException $e){fh_assert($e->getMessage()==='invalid_path','path escape rejected');}}
$trust = static function($args,$url)use($origin){if(str_starts_with($url,$origin.'/'))unset($args['sslcertificates']);return $args;};
add_filter('http_request_args',$trust,100,2);
try{Frameleaf_Connect_HTTP::json($origin,'/.well-known/oauth-authorization-server');throw new RuntimeException('unexpected');}catch(RuntimeException $e){fh_assert($e->getMessage()==='connection_failed','untrusted TLS certificate rejected');}finally{remove_filter('http_request_args',$trust,100);}
$options=get_option('frameleaf_connect_origins');update_option('frameleaf_connect_origins',[$origin=>['client_id'=>'','private'=>false]],false);
try{Frameleaf_Connect_HTTP::json($origin,'/.well-known/oauth-authorization-server');throw new RuntimeException('unexpected');}catch(RuntimeException $e){fh_assert($e->getMessage()==='connection_failed','private network requires administrator allowance');}finally{update_option('frameleaf_connect_origins',$options,false);}
