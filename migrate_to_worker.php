<?php
// Put beside your existing developers/api/keys.php temporarily, or adjust the require path.
// Run once in a browser while signed in as admin, then DELETE THIS FILE.
// Before use: edit $worker and $adminSecret below.
$worker = 'https://minecodelabs-api.zerpstudio-admin.workers.dev/';
$adminSecret = 'augy2026';
require_once __DIR__ . '/lib/bootstrap.php';
ensureApiSchema($pdo);
function pushMcl($url,$secret,$payload){$ch=curl_init($url);curl_setopt_array($ch,[CURLOPT_POST=>true,CURLOPT_RETURNTRANSFER=>true,CURLOPT_HTTPHEADER=>['Authorization: Bearer '.$secret,'Content-Type: application/json'],CURLOPT_POSTFIELDS=>json_encode($payload),CURLOPT_TIMEOUT=>30]);$r=curl_exec($ch);$e=curl_error($ch);$c=curl_getinfo($ch,CURLINFO_HTTP_CODE);curl_close($ch);if($r===false||$e||$c<200||$c>=300)throw new RuntimeException('Worker sync failed: '.$c.' '.$e.' '.$r);}
$keys=$pdo->query('SELECT * FROM mcl_api_keys')->fetchAll(PDO::FETCH_ASSOC);
$usage=$pdo->query('SELECT * FROM mcl_api_usage')->fetchAll(PDO::FETCH_ASSOC);
foreach($keys as $k) pushMcl($worker.'/_mcl_admin/create',$adminSecret,['key'=>$k]);
foreach($usage as $u) pushMcl($worker.'/_mcl_admin/usage',$adminSecret,['usage'=>$u]);
echo 'Migrated '.count($keys).' keys and '.count($usage).' usage rows. DELETE THIS FILE NOW.';
