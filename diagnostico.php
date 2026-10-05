<?php
// Diagnóstico del dispositivo ZKTeco

$ip = '192.168.118.172';
$port = 4370;

echo "=== Diagnostico ZKTeco {$ip}:{$port} ===\n\n";

// 1. Ping
echo "[1] Ping:\n";
exec("ping -n 1 -w 1500 {$ip}", $out, $code);
echo ($code === 0) ? "    OK\n" : "    FALLO\n";

// 2. TCP connect
echo "[2] Conexion TCP tcp://{$ip}:{$port}\n";
$errno = 0; $errstr = '';
$sock = @stream_socket_client("tcp://{$ip}:{$port}", $errno, $errstr, 8, STREAM_CLIENT_CONNECT);
if (!$sock) {
    echo "    FALLO: {$errno} {$errstr}\n";
    exit;
}
echo "    Conectado.\n";
stream_set_timeout($sock, 5, 0);

// 3. Enviar CMD_CONNECT (1000), sin payload
function checksum($frame) {
    $cs = 0; $l = strlen($frame);
    for ($i = 0; $i + 1 < $l; $i += 2) {
        $w = ord($frame[$i]) | (ord($frame[$i+1]) << 8);
        $cs += $w;
        if ($cs > 65535) $cs -= 65535;
    }
    if ($l % 2) $cs += ord($frame[$l-1]);
    while ($cs > 65535) $cs -= 65535;
    $cs = ~$cs;
    while ($cs < 0) $cs += 65535;
    return $cs;
}

function hexdump($s) {
    $h = '';
    for ($i = 0; $i < strlen($s); $i++) {
        $h .= sprintf('%02x ', ord($s[$i]));
        if (($i+1) % 16 == 0) $h .= "\n        ";
    }
    return trim($h);
}

$session = 0;
$reply = 65534;

$cmd = 1000;
$payload = '';
// Orden pyzk: checksum con el reply_id actual, luego incrementar
$buf = pack('vvvv', $cmd, 0, $session, $reply) . $payload;
$cs = checksum($buf);
echo "    checksum calculado = 0x" . sprintf('%04x', $cs) . "\n";
$reply++;
if ($reply >= 65535) $reply -= 65535;
$frame = pack('vvvv', $cmd, $cs, $session, $reply) . $payload;
$top = pack('vvV', 0x5050, 0x7282, strlen($frame));
$packet = $top . $frame;

echo "[3] Enviando CMD_CONNECT (cmd=1000)\n";
echo "    Top:    " . hexdump($top) . "\n";
echo "    Frame:  " . hexdump($frame) . "\n";
$w = @fwrite($sock, $packet);
echo "    Escritos: {$w} bytes\n";

// Leer respuesta con multiples intentos
$raw = '';
echo "[4] Leyendo respuesta...\n";
$s = @fread($sock, 4096);
if ($s === false || $s === '') {
    $m = stream_get_meta_data($sock);
    echo "    FALLO / sin datos. timed_out=" . var_export($m['timed_out'], true) . " unread=" . $m['unread_bytes'] . "\n";
    if (isset($m['timed_out']) && $m['timed_out']) {
        echo "    La conexion expiro sin respuesta del dispositivo.\n";
    }
} else {
    echo "    Respuesta (" . strlen($s) . " bytes):\n";
    echo "    " . hexdump($s) . "\n";
    $raw = $s;
    if (strlen($raw) >= 16) {
        $h = unpack('v4', substr($raw, 8, 8));
        echo "    Header: cmd={$h[1]} checksum={$h[2]} session={$h[3]} reply={$h[4]}\n";
    }
}

fclose($sock);
echo "\n=== Fin del diagnostico ===\n";