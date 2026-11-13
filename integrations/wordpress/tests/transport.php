<?php
/** Controlled DNS/transport regression: no network request is performed. Run with wp eval-file. */
function ft_assert($condition,$label){if(!$condition)throw new RuntimeException('FAIL '.$label);echo 'PASS '.$label."\n";}
class Frameleaf_Transport_Fixture extends Frameleaf_Connect_HTTP {
    public static array $answers = [];
    public static array $pins = [];
    public static int $lookups = 0;
    public static function inspect_pin(string $host,int $port,string $address):array{return parent::pin_options($host,$port,$address);}
    protected static function lookup_addresses(string $host): array { ++self::$lookups;return self::$answers; }
    protected static function pin_options(string $host,int $port,string $address): array {
        $options=parent::pin_options($host,$port,$address);self::$pins[]=$options;return $options;
    }
}
$ipv6=Frameleaf_Transport_Fixture::inspect_pin('ipv6.example.test',443,'2606:4700:4700::1111');
ft_assert($ipv6[CURLOPT_RESOLVE]===['ipv6.example.test:443:[2606:4700:4700::1111]']&&$ipv6[CURLOPT_IPRESOLVE]===CURL_IPRESOLVE_V6,'validated IPv6 addresses use explicit bracketed pins');
$origin='https://pinning.example.test:39444';$path='/.well-known/oauth-authorization-server';
$saved=get_option('frameleaf_connect_origins');update_option('frameleaf_connect_origins',[$origin=>['private'=>false,'client_id'=>'fixture']],false);
$mock = static function($pre,$args,$url)use($origin,$path){
 if($url!==$origin.$path)return $pre;
 $other_url='https://unrelated.example.test/';$other_headers=[];$other_data=[];$other_method='GET';$other_options=['transport'=>'unchanged','proxy'=>'unchanged'];
 do_action_ref_array('requests-requests.before_request',[&$other_url,&$other_headers,&$other_data,&$other_method,&$other_options]);
 ft_assert($other_options===['transport'=>'unchanged','proxy'=>'unchanged'],'unrelated WordPress requests retain their transport and proxy');
 $headers=[];$data=[];$method='GET';$options=['transport'=>'WpOrg\\Requests\\Transport\\Fsockopen','proxy'=>'http://proxy.example.test'];
 do_action_ref_array('requests-requests.before_request',[&$url,&$headers,&$data,&$method,&$options]);
 ft_assert($options['transport']==='WpOrg\\Requests\\Transport\\Curl','exact request forces a pinnable transport');
 ft_assert($options['proxy']===false,'Requests proxy cannot resolve the destination separately');
 // A DNS change after validation must not change the socket destination.
 Frameleaf_Transport_Fixture::$answers=['::1','10.0.0.1'];
 $handle=curl_init();do_action_ref_array('http_api_curl',[&$handle,$args,$url]);
 ft_assert(count(Frameleaf_Transport_Fixture::$pins)===1,'native cURL hook applies the validated pin');
 $pin=Frameleaf_Transport_Fixture::$pins[0];
 ft_assert($pin[CURLOPT_RESOLVE]===['pinning.example.test:39444:93.184.216.34'],'public A is pinned despite private AAAA or changed DNS');
 ft_assert($pin[CURLOPT_PROXY]===''&&$pin[CURLOPT_NOPROXY]==='*','environment and WordPress proxies cannot bypass the pin');
 ft_assert($pin[CURLOPT_SSL_VERIFYPEER]===true&&$pin[CURLOPT_SSL_VERIFYHOST]===2,'hostname and certificate verification remain enabled');
 ft_assert($args['redirection']===0,'redirect cannot escape the pinned origin');
 return ['headers'=>[],'body'=>'{}','response'=>['code'=>200,'message'=>'OK'],'cookies'=>[]];
};
add_filter('pre_http_request',$mock,10,3);
try {
 Frameleaf_Transport_Fixture::$answers=['93.184.216.34','fd00::1'];
 try { Frameleaf_Transport_Fixture::request($origin,$path); }
 catch(Throwable $e){throw new RuntimeException('FAIL validated transport pin is missing: '.$e->getMessage());}
 ft_assert(Frameleaf_Transport_Fixture::$lookups===1,'request uses one resolved address snapshot');
 foreach([['fd00::1'],['::1'],['10.0.0.1'],['::ffff:127.0.0.1']] as $addresses){
  Frameleaf_Transport_Fixture::$answers=$addresses;
  try{Frameleaf_Transport_Fixture::request($origin,$path);throw new RuntimeException('unexpected');}catch(RuntimeException $e){ft_assert($e->getMessage()==='connection_failed','private IPv4/IPv6 destination denied before transport');}
 }
} finally {remove_filter('pre_http_request',$mock,10);update_option('frameleaf_connect_origins',$saved,false);}
