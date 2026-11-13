<?php
/** Actual WordPress media pipeline; run in the isolated fixture installation only. */
function fm_assert($condition,$label) { if(!$condition) throw new RuntimeException('FAIL '.$label); echo 'PASS '.$label."\n"; }
fm_assert(class_exists('Frameleaf_Connect_Media'),'native media importer exists');
$editor=get_user_by('login','fixture-editor');wp_set_current_user($editor->ID);
$media=new Frameleaf_Connect_Media();
$id='00000000-0000-4000-8000-000000000001';
$table=$GLOBALS['wpdb']->prefix.'frameleaf_imports';$GLOBALS['wpdb']->query("DELETE FROM $table");
$first=$media->import($id);
fm_assert(get_post_type($first['id'])==='attachment','import creates native attachment');
$again=$media->import($id);
fm_assert($first['id']===$again['id'],'identical bytes reuse native attachment');
fm_assert(str_starts_with($first['url'],site_url()),'attachment uses permanent WordPress URL');
fm_assert(get_post_meta($first['id'],'_frameleaf_content_sha256',true)===hash_file('sha256',get_attached_file($first['id'])),'revision identifies imported bytes');
// The provider deliberately keeps updatedAt identical while replacing bytes.
$marker=dirname(ABSPATH).'/version2';file_put_contents($marker,'1');
try { $changed=$media->import($id); } finally { unlink($marker); }
fm_assert($changed['id']!==$first['id'],'changed bytes with equal updatedAt create a new attachment');
fm_assert($media->import($id)['id']===$first['id'],'original content still resolves its canonical copy');
wp_set_current_user(get_user_by('login','fixture-subscriber')->ID);
try{$media->import($id);throw new RuntimeException('FAIL subscriber imported');}catch(RuntimeException $e){fm_assert($e->getMessage()==='forbidden','subscriber cannot import');}
wp_set_current_user($editor->ID);
wp_delete_attachment($first['id'],true);
$recreated=$media->import($id);
fm_assert($recreated['id']!==$first['id'],'deleted local attachment can be imported again in one request');
foreach([$recreated['id'],$changed['id']] as $attachment)wp_delete_attachment($attachment,true);

// Native sideload errors must remove both temporary bytes and the deduplication claim.
$GLOBALS['wpdb']->query("DELETE FROM $table");
$before=glob(get_temp_dir().'frameleaf*') ?: [];
$blocked=wp_tempnam('frameleaf-readonly');
$deny=static function($upload)use($blocked){$upload['path']=$blocked.'/child';return $upload;};
add_filter('upload_dir',$deny);
try { $media->import($id); throw new RuntimeException('FAIL read-only storage accepted'); }
catch(RuntimeException $e) { fm_assert($e->getMessage()==='storage_unavailable','read-only media storage fails safely: '.$e->getMessage()); }
finally {remove_filter('upload_dir',$deny);wp_delete_file($blocked);}
fm_assert($before===(glob(get_temp_dir().'frameleaf*') ?: []),'failed sideload removes unpublished temporary file');
fm_assert((int)$GLOBALS['wpdb']->get_var("SELECT COUNT(*) FROM $table WHERE attachment_id=0")===0,'failed sideload releases its exact pending claim');
