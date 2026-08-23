<?php
declare(strict_types=1);
require_once __DIR__ . '/lib/bootstrap.php';
ensureApiSchema($pdo);
$owner = requireOwner();

$message = '';
$error = '';
$createdKey = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    verifyCsrf();
    $action = $_POST['action'] ?? '';

    if ($action === 'create') {
        $name = trim((string)($_POST['name'] ?? ''));
        $expiryChoice = (string)($_POST['expiry'] ?? '30d');
        $rate = (int)($_POST['rate_limit'] ?? 500);

        if ($name === '' || mb_strlen($name) > 120) {
            $error = 'Enter a key name between 1 and 120 characters.';
        } elseif ($rate < 1 || $rate > 500) {
            $error = 'The rate limit must be between 1 and 500 tokens per minute.';
        } else {
            $expires = keyExpiry($expiryChoice);
            if ($expires === false) {
                $error = 'Invalid expiry option.';
            } else {
                [$raw, $hash, $prefix] = makeApiKey();
                $st = $pdo->prepare('INSERT INTO mcl_api_keys (owner_id,name,key_prefix,key_hash,rate_limit_tpm,expires_at,created_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP())');
                $st->execute([$owner, $name, $prefix, $hash, $rate, $expires]);
                $newId = (int) $pdo->lastInsertId();
                $createdKey = $raw;

                $fetchNew = $pdo->prepare('SELECT * FROM mcl_api_keys WHERE id=?');
                $fetchNew->execute([$newId]);
                $newRow = $fetchNew->fetch();
                if ($newRow && !mclWorkerSyncKey($newRow)) {
                    $error = 'Key created, but MineCodeLabs could not sync it to the live API just now. It may take a moment to start working — if calls using this key still fail with INVALID_API_KEY after a few minutes, let support know.';
                }
            }
        }
    } elseif ($action === 'revoke') {
        $id = (int)($_POST['key_id'] ?? 0);
        $st = $pdo->prepare('UPDATE mcl_api_keys SET revoked_at=UTC_TIMESTAMP() WHERE id=? AND owner_id=? AND revoked_at IS NULL');
        $st->execute([$id, $owner]);
        if ($st->rowCount()) {
            $message = 'API key revoked.';
            $fetchUpdated = $pdo->prepare('SELECT * FROM mcl_api_keys WHERE id=? AND owner_id=?');
            $fetchUpdated->execute([$id, $owner]);
            $updatedRow = $fetchUpdated->fetch();
            if ($updatedRow && !mclWorkerSyncUpdate($updatedRow)) {
                $message .= ' Warning: the live API could not be reached to confirm the revoke — this key may keep working there for a few minutes until sync succeeds.';
            }
        } else {
            $message = 'That key was not found or was already revoked.';
        }
    } elseif ($action === 'reduce_rate') {
        $id = (int)($_POST['key_id'] ?? 0);
        $rate = (int)($_POST['new_rate'] ?? 0);
        if ($rate < 1 || $rate > 500) {
            $error = 'Rate limit must be between 1 and 500 TPM.';
        } else {
            $st = $pdo->prepare('UPDATE mcl_api_keys SET rate_limit_tpm=? WHERE id=? AND owner_id=? AND rate_limit_tpm>=? AND revoked_at IS NULL');
            $st->execute([$rate, $id, $owner, $rate]);
            if ($st->rowCount()) {
                $message = 'Rate limit reduced.';
                $fetchUpdated = $pdo->prepare('SELECT * FROM mcl_api_keys WHERE id=? AND owner_id=?');
                $fetchUpdated->execute([$id, $owner]);
                $updatedRow = $fetchUpdated->fetch();
                if ($updatedRow && !mclWorkerSyncUpdate($updatedRow)) {
                    $message .= ' Warning: the live API could not be reached to confirm the new limit yet.';
                }
            } else {
                $message = 'The new limit must be lower than the current limit.';
            }
        }
    }
}

$st = $pdo->prepare('SELECT * FROM mcl_api_keys WHERE owner_id=? ORDER BY created_at DESC');
$st->execute([$owner]);
$keys = $st->fetchAll();
$liveUsage = mclWorkerFetchLiveUsage($owner);
$csrf = csrfToken();
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Keys — MineCodeLabs</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#080b12;color:#eef3ff;font-family:Inter,system-ui,sans-serif}.wrap{max-width:1000px;margin:auto;padding:35px 20px 70px}a{color:inherit;text-decoration:none}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:30px;gap:15px}.back{color:#9fb0cc}.panel{background:linear-gradient(180deg,#111a2c,#0c121e);border:1px solid #27334d;border-radius:15px;padding:25px;margin-bottom:22px}.panel h1,.panel h2{margin-top:0}.muted{color:#9eabc5;line-height:1.6}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field label{display:block;color:#cbd7ec;font-size:13px;margin-bottom:7px}.field input,.field select{width:100%;padding:12px;border-radius:9px;border:1px solid #30405f;background:#0b111d;color:#fff;outline:none}.btn{border:0;border-radius:9px;padding:11px 15px;font-weight:700;cursor:pointer;background:#2878f2;color:#fff}.btn.danger{background:#7f1d1d}.btn.secondary{background:#1a2740}.create{margin-top:16px}.alert{padding:14px;border-radius:10px;margin-bottom:18px;background:#10253b;border:1px solid #29557e;color:#cfe5ff}.alert.err{background:#32161b;border-color:#71323b}.secret{background:#09131f;border:1px solid #2878f2;border-radius:12px;padding:18px;margin-bottom:22px}.secret code{display:block;overflow:auto;padding:14px;margin-top:10px;background:#05080d;border-radius:8px;color:#a9d0ff}.key{border:1px solid #27334d;border-radius:12px;padding:18px;margin-top:14px;background:#0d1422}.keyrow{display:flex;justify-content:space-between;gap:18px;align-items:center}.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px}.pill{padding:5px 8px;background:#182642;border-radius:999px;color:#a9cfff;font-size:12px}.revoked{opacity:.55}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}.inline{display:flex;gap:8px;align-items:center}.inline input{width:100px}.warning{color:#f7c979;font-size:13px}@media(max-width:700px){.grid{grid-template-columns:1fr}.keyrow{flex-direction:column;align-items:flex-start}}
</style>
</head>
<body>
<div class="wrap">
<div class="top"><div><strong>MineCodeLabs API</strong><div class="muted">API key manager</div></div><a class="back" href="index.php">← API Reference</a></div>

<?php if ($error): ?><div class="alert err"><?= htmlspecialchars($error) ?></div><?php endif; ?>
<?php if ($message): ?><div class="alert"><?= htmlspecialchars($message) ?></div><?php endif; ?>

<?php if ($createdKey): ?>
<div class="secret">
<strong>API key created — copy it now</strong>
<div class="warning">For security, MineCodeLabs stores only a hash of this key. It will not be shown again.</div>
<code id="newKey"><?= htmlspecialchars($createdKey) ?></code>
<button class="btn secondary" onclick="navigator.clipboard.writeText(document.getElementById('newKey').textContent);this.textContent='Copied!'">Copy key</button>
</div>
<?php endif; ?>

<div class="panel">
<h1>Create API key</h1>
<p class="muted">The maximum rate limit is <strong>500 tokens/minute</strong>. You can choose any lower value. Once created, a key's expiry cannot be extended and its rate limit can only be reduced.</p>
<form method="post">
<input type="hidden" name="csrf" value="<?= htmlspecialchars($csrf) ?>"><input type="hidden" name="action" value="create">
<div class="grid">
<div class="field"><label>API key name</label><input name="name" maxlength="120" required placeholder="My Discord Bot"></div>
<div class="field"><label>Expiry</label><select name="expiry"><option value="1d">1 day</option><option value="7d">7 days</option><option value="30d" selected>30 days</option><option value="90d">90 days</option><option value="365d">365 days</option><option value="never">Never</option></select></div>
<div class="field"><label>Rate limit (tokens/minute)</label><input name="rate_limit" type="number" min="1" max="500" value="500" required></div>
</div>
<button class="btn create" type="submit">Create API key</button>
</form>
</div>

<div class="panel">
<h2>Your API keys</h2>
<?php if (!$keys): ?><p class="muted">You have no API keys yet.</p><?php endif; ?>
<?php foreach ($keys as $k): ?>
<?php $state = $liveUsage[(int)$k['id']] ?? publicKeyState($k,$pdo); $expired = $k['expires_at'] !== null && strtotime($k['expires_at'].' UTC') <= time(); $inactive = $k['revoked_at'] !== null || $expired; ?>
<div class="key <?= $inactive ? 'revoked' : '' ?>">
<div class="keyrow">
<div><strong><?= htmlspecialchars($k['name']) ?></strong><div class="muted"><?= htmlspecialchars($k['key_prefix']) ?>••••••••</div></div>
<div><?= $inactive ? '<span class="pill">Inactive</span>' : '<span class="pill">Active</span>' ?></div>
</div>
<div class="meta">
<span class="pill">Limit: <?= (int)$k['rate_limit_tpm'] ?> TPM</span>
<span class="pill">Used: <?= $state['used'] ?></span>
<span class="pill">Remaining: <?= $state['remaining'] ?></span>
<span class="pill">Expires: <?= $k['expires_at'] ? htmlspecialchars($k['expires_at'].' UTC') : 'Never' ?></span>
</div>
<?php if (!$inactive): ?>
<div class="actions">
<form method="post" class="inline"><input type="hidden" name="csrf" value="<?= htmlspecialchars($csrf) ?>"><input type="hidden" name="action" value="reduce_rate"><input type="hidden" name="key_id" value="<?= (int)$k['id'] ?>"><input name="new_rate" type="number" min="1" max="<?= (int)$k['rate_limit_tpm'] - 1 ?>" placeholder="Lower TPM" <?= ((int)$k['rate_limit_tpm'] <= 1 ? 'disabled' : '') ?>><button class="btn secondary" type="submit" <?= ((int)$k['rate_limit_tpm'] <= 1 ? 'disabled' : '') ?>>Reduce limit</button></form>
<form method="post" onsubmit="return confirm('Revoke this API key? This cannot be undone.')"><input type="hidden" name="csrf" value="<?= htmlspecialchars($csrf) ?>"><input type="hidden" name="action" value="revoke"><input type="hidden" name="key_id" value="<?= (int)$k['id'] ?>"><button class="btn danger" type="submit">Revoke</button></form>
</div>
<?php endif; ?>
</div>
<?php endforeach; ?>
</div>
</div>
</body>
</html>
