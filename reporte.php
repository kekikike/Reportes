<?php
/**
 * Reporte de asistencia del biométrico ZKTeco K40.
 *
 * Uso:
 *   Web:     reporte.php?ip=192.168.118.172&desde=2026-01-01&hasta=2026-01-31
 *            reporte.php?formato=csv&desde=...&hasta=...   (descarga CSV)
 *   CLI:     php reporte.php --ip=192.168.118.172 --desde=2026-01-01 --hasta=2026-01-31
 *            php reporte.php --csv
 */

error_reporting(E_ALL);
ini_set('display_errors', '1');
require_once __DIR__ . '/zk.php';

// ------------------------------------------------------------------ *
// parámetros
// ------------------------------------------------------------------ *

$isCli = (PHP_SAPI === 'cli');

function param($cliName, $getName, $default = null) {
    global $isCli;
    if ($isCli) {
        foreach ($_SERVER['argv'] as $arg) {
            if (strpos($arg, '--' . $cliName . '=') === 0) {
                return substr($arg, strlen('--' . $cliName . '='));
            }
            if ($arg === '--' . $cliName) {
                return '1';
            }
        }
        return $default;
    }
    return isset($_GET[$getName]) && $_GET[$getName] !== '' ? $_GET[$getName] : $default;
}

$ip     = param('ip', 'ip', '192.168.118.172');
$port   = (int) param('port', 'port', 4370);
$pass   = (int) param('pass', 'pass', 0);
$desde  = param('desde', 'desde', '');
$hasta  = param('hasta', 'hasta', '');
$csv    = param('csv', 'formato', '');
$csv    = ($csv === 'csv' || $csv === '1');

if ($desde !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $desde)) $desde = '';
if ($hasta !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $hasta)) $hasta = '';

// ------------------------------------------------------------------ *
// extracción de datos
// ------------------------------------------------------------------ *

$usuarios = array();
$asistencia = array();
$error = '';

try {
    $zk = new ZKClient($ip, $port, $pass, 10);

    if (!$isCli && !$csv) {
        echo '<div style="font-family:sans-serif;font-size:14px;color:#115">Conectando a ' . htmlspecialchars($ip) . ':' . $port . ' ...</div>';
        flush();
    }

    $zk->connect();
    $zk->readSizes();
    $usuarios = $zk->getUsers();
    $asistencia = $zk->getAttendance();

    if ($zk->is_enabled) {
        $zk->disable();
    }

    // unir nombre de usuario
    foreach ($asistencia as $i => $reg) {
        $userId = (string) $reg['user_id'];
        if (isset($usuarios[$userId])) {
            $asistencia[$i]['name'] = $usuarios[$userId]['name'];
        } else {
            $asistencia[$i]['name'] = 'Desconocido';
        }
    }

    if (!$zk->is_enabled) {
        try { $zk->enable(); } catch (Exception $e) {}
    }
    $zk->disconnect();

} catch (Exception $e) {
    $error = $e->getMessage();
}

// ------------------------------------------------------------------ *
// filtro por rango de fechas
// ------------------------------------------------------------------ *

$desdeTs = $desde !== '' ? strtotime($desde . ' 00:00:00') : null;
$hastaTs = $hasta !== '' ? strtotime($hasta . ' 23:59:59') : null;

$filtrada = array();
foreach ($asistencia as $reg) {
    $ts = strtotime($reg['timestamp']);
    if ($desdeTs !== null && $ts < $desdeTs) continue;
    if ($hastaTs !== null && $ts > $hastaTs) continue;
    $filtrada[] = $reg;
}

usort($filtrada, function ($a, $b) {
    return strcmp($a['timestamp'], $b['timestamp']);
});

// ------------------------------------------------------------------ *
// salida CSV
// ------------------------------------------------------------------ *

function portada($datos) {
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="reporte_asistencia_' . date('Ymd_His') . '.csv"');
    echo "\xEF\xBB\xBF"; // BOM UTF-8 para Excel
    $out = fopen('php://output', 'w');
    fputcsv($out, array('Usuario', 'Nombre', 'Fecha y Hora', 'Tipo', 'Verificacion'));
    foreach ($datos as $r) {
        fputcsv($out, array(
            $r['user_id'],
            $r['name'],
            $r['timestamp'],
            ZKClient::punchLabel($r['punch']),
            ZKClient::statusLabel($r['status']),
        ));
    }
    fclose($out);
    return;
}

if ($csv) {
    portada($filtrada);
    return;
}

// ------------------------------------------------------------------ *
// CLI (tabla plana)
// ------------------------------------------------------------------ *

if ($isCli) {
    if ($error) {
        fwrite(STDERR, 'ERROR: ' . $error . PHP_EOL);
        exit(1);
    }
    echo "Biometrico: {$ip}:{$port}" . PHP_EOL;
    echo "Usuarios: " . count($usuarios) . " | Registros: " . count($asistencia) . " | Registros filtrados: " . count($filtrada) . PHP_EOL;
    if ($desde) echo "Rango: {$desde} -> " . ($hasta ? $hasta : 'hoy') . PHP_EOL;
    echo str_repeat('-', 70) . PHP_EOL;
    printf("%-10s %-20s %-20s %-28s %s%s", 'Usuario', 'Nombre', 'Fecha y Hora', 'Tipo', 'Verificacion', PHP_EOL);
    echo str_repeat('-', 70) . PHP_EOL;
    foreach ($filtrada as $r) {
        printf("%-10s %-20s %-20s %-28s %s%s",
            $r['user_id'],
            mb_substr($r['name'], 0, 20),
            $r['timestamp'],
            ZKClient::punchLabel($r['punch']),
            ZKClient::statusLabel($r['status']),
            PHP_EOL
        );
    }
    echo str_repeat('-', 70) . PHP_EOL;
    echo "Para exportar CSV: php reporte.php --csv --desde=YYYY-MM-DD --hasta=YYYY-MM-DD" . PHP_EOL;
    exit(0);
}
?>
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reporte Biométrico ZKTeco</title>
<style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 20px; background: #f4f6fb; color: #222; }
    .card { background: #fff; border-radius: 8px; padding: 18px 22px; box-shadow: 0 1px 4px rgba(0,0,0,.12); margin-bottom: 18px; }
    h1 { margin: 0 0 4px; font-size: 20px; }
    small { color: #777; }
    form { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-top: 10px; }
    label { font-size: 12px; color: #444; display:flex; flex-direction:column; gap:3px; }
    input, button { padding: 7px 10px; border: 1px solid #c5ccd9; border-radius: 6px; font-size: 14px; }
    button { background: #2563eb; color: #fff; border: none; cursor: pointer; }
    button.sec { background: #16a34a; }
    .error { background: #fdecea; color: #b3261e; padding: 10px 14px; border-radius: 6px; border: 1px solid #f5c6c0; }
    .stats { display: flex; gap: 26px; margin-top: 8px; flex-wrap: wrap; }
    .stat b { font-size: 22px; display: block; color: #2563eb; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid #e6e9f0; }
    th { background: #eef1f7; position: sticky; top: 0; }
    tr:hover { background: #f8faff; }
    .scroll { max-height: 65vh; overflow: auto; border: 1px solid #e6e9f0; border-radius: 6px; }
</style>
</head>
<body>

<div class="card">
    <h1>Reporte de Asistencia &mdash; ZKTeco K40</h1>
    <small><?php echo htmlspecialchars($ip); ?>:<?php echo (int)$port; ?> (puerto 4370)</small>

    <form method="get">
        <label>IP / Puerto
            <input type="text" name="ip" value="<?php echo htmlspecialchars($ip); ?>"><br>
            <input type="text" name="port" value="<?php echo (int)$port; ?>" style="margin-top:3px">
        </label>
        <label>Desde
            <input type="date" name="desde" value="<?php echo htmlspecialchars($desde); ?>">
        </label>
        <label>Hasta
            <input type="date" name="hasta" value="<?php echo htmlspecialchars($hasta); ?>">
        </label>
        <button type="submit">Generar reporte</button>
        <a href="?<?php echo http_build_query(array_merge($_GET, array('formato' => 'csv'))); ?>">
            <button type="button" class="sec">Descargar CSV</button>
        </a>
    </form>
</div>

<?php if ($error): ?>
    <div class="card error"><?php echo nl2br(htmlspecialchars($error)); ?></div>
<?php endif; ?>

<?php if (!$error && !isset($_GET['nock'])): ?>
<div class="card">
    <div class="stats">
        <div class="stat"><b><?php echo count($usuarios); ?></b>Usuarios</div>
        <div class="stat"><b><?php echo count($asistencia); ?></b>Registros totales</div>
        <div class="stat"><b><?php echo count($filtrada); ?></b>Registros del filtro</div>
    </div>
</div>
<?php endif; ?>

<?php if (!$error && count($filtrada) > 0): ?>
<div class="card">
    <div class="scroll">
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>Usuario</th>
                    <th>Nombre</th>
                    <th>Fecha y Hora</th>
                    <th>Tipo</th>
                    <th>Verificación</th>
                </tr>
            </thead>
            <tbody>
                <?php $n = 1; foreach ($filtrada as $r): ?>
                <tr>
                    <td><?php echo $n++; ?></td>
                    <td><?php echo htmlspecialchars($r['user_id']); ?></td>
                    <td><?php echo htmlspecialchars($r['name']); ?></td>
                    <td><?php echo htmlspecialchars($r['timestamp']); ?></td>
                    <td><?php echo ZKClient::punchLabel($r['punch']); ?></td>
                    <td><?php echo ZKClient::statusLabel($r['status']); ?></td>
                </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
    </div>
</div>
<?php elseif (!$error): ?>
<div class="card">No hay registros de asistencia<?php echo ($desde || $hasta) ? ' en el rango seleccionado' : ''; ?>.</div>
<?php endif; ?>

</body>
</html>