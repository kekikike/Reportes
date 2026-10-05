<?php
// Diagnóstico UDP + variantes del ZKTeco

$ip = '192.168.118.172';
$port = 4370;

echo "=== Diagnostico UDP ZKTeco {$ip}:{$port} ===\n\n";

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
    }
    return trim($h);
}

// --- Prueba UDP frame sin top ---
$sock = @stream_socket_client("udp://{$ip}:{$port}", $errno, $errstr, 5);
if (!$sock) { echo "UDP FALLO: $errstr\n"; exit; }
stream_set_timeout($sock, 3, 0);

$session = 0; $reply = 65534;
$cmd = 1000; $payload = '';
$buf = pack('vvvv', $cmd, 0, $session, $reply) . $payload;
$cs = checksum($buf);
$reply++;
$frame = pack('vvvv', $cmd, $cs, $session, $reply) . $payload;

echo "[UDP] Enviando CMD_CONNECT (sin Top): " . hexdump($frame) . "\n";
fwrite($sock, $frame);
$s = @fread($sock, 4096);
echo "[UDP] Respuesta: " . ($s !== false && $s !== '' ? hexdump($s) : '(ninguna)') . "\n";
@fclose($sock);

// --- Prueba TCP distintos timeouts y reintentos ---
echo "\n=== TCP con reintentos ===\n";
$sock = @stream_socket_client("tcp://{$ip}:{$port}", $errno, $errstr, 8);
stream_set_timeout($sock, 4, 0);

// intentar varias veces el CONNECT
$session = 0; $reply = 65534;
for ($intento = 1; $intento <= 3; $intento++) {
    $buf = pack('vvvv', $cmd, 0, $session, $reply) . $payload;
    $cs = checksum($buf);
    $reply++;
    $frame = pack('vvvv', $cmd, $cs, $session, $reply) . $payload;
    $top = pack('vvV', 0x5050, 0x7282, strlen($frame));
    fwrite($sock, $top . $frame);
    echo "Intento $intento enviado... ";
    $s = @fread($sock, 1024);
    if ($s !== false && $s !== '') {
        echo "RESPUESTA " . strlen($s) . "B: " . hexdump($s) . "\n";
        break;
    } else {
        echo "sin respuesta\n";
    }
}
@fclose($sock);

echo "\n=== Fin ===\n";