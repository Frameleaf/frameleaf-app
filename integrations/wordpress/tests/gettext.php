<?php
require_once ABSPATH.'wp-includes/pomo/mo.php';
foreach(['en_US','fr_FR','es_ES','de_DE','it_IT','pt_PT','nl_NL','pl_PL','sv_SE','da_DK','nb_NO'] as $locale){
 $file=getenv('FRAMELEAF_PACKAGE_DIR').'/languages/frameleaf-connect-'.$locale.'.mo';
 $mo=new MO();$loaded=$mo->import_from_file($file);if(!$loaded||count($mo->entries)!==33)throw new RuntimeException('Invalid MO '.$locale.' loaded='.(int)$loaded.' entries='.count($mo->entries));
 $translated=$mo->translate('Import image');if(!$translated||($locale!=='en_US'&&$translated==='Import image'))throw new RuntimeException('Untranslated '.$locale);
 echo 'PASS native gettext '.$locale.': '.$translated."\n";
}
