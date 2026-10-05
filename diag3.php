<?php
// Test completo UDP: CONNECT -> AUTH -> SIZES -> READ_ATTLOG

$s = @stream_socket_client("udp://192.168.118.172:4370", $e, $es, 5);
stream_set_timeout($s, 5);

function cs($f) {
    $c = 0; $l = strlen($f);
    for ($i = 0; $i + 1 < $l; $i += 2) {
        $w = ord($f[$i]) | (ord($f[$i+1]) << 8);
        $c += $w;
        if ($c > 65535) $c -= 65535;
    }
    if ($l % 2) $c += ord($f[$l-1]);
    while ($c > 65535) $c -= 65535;
    $c = ~$c;
    while ($c < 0) $c += 65535;
    return $c;
}

function mkframe(&$rid, $sid, $cmd, $payload='') {
    // checksum calculado con el rid actual, header con rid+1
    $buf = pack("vvvv", $cmd, 0, $sid, $rid) . $payload;
    $checksum = cs($buf);
    $newrid = $rid + 1;
    if ($newrid >= 65535) $newrid -= 65535;
    $frame = pack("vvvv", $cmd, $checksum, $sid, $newrid) . $payload;
    return $frame;
}

function sendrecv($s, &$rid, &$sid, $cmd, $payload='', $expected=false) {
    $frame = mkframe($rid, $sid, $cmd, $payload);
    fwrite($s, $frame);
    $r = @fread($s, 65536);
    if ($r === false || $r === '') {
        echo "  TIMEOUT o error de lectura\n";
        return null;
    }
    $h = unpack("v4", $r);
    $data = substr($r, 8);
    $sid = $h[3];
    $rid = $h[4];
    echo "  cmd={$h[1]} session={$sid} reply={$h[4]} data=" . strlen($data) . "B: " . bin2hex(substr($r,0, min(20,strlen($r)))) . "...\n";
    if ($expected !== false && $h[1] != $expected) {
        echo "  ESPERABA cmd={$expected}, RECIBI {$h[1]}\n";
    }
    return array('command' => $h[1], 'session' => $sid, 'data' => $data);
}

// --- CONNECT ---
echo "[1] CONNECT\n";
$sid = 0; $rid = 65534;
$r = sendrecv($s, $rid, $sid, 1000, '', 2005);
if (!$r) exit;
$sid = $r['session'];

// --- AUTH (key=0) ---
echo "[2] AUTH (commkey=0, session={$sid})\n";
$k = 0;
for ($i = 0; $i < 32; $i++) {
    if ($k & (1 << $i)) $k = ($k << 1) | 1; else $k = $k << 1;
}
$k = ($k + $sid) & 0xFFFFFFFF;
$b = pack("V", $k);
$b0 = ord($b[0]) ^ ord('Z');
$b1 = ord($b[1]) ^ ord('K');
$b2 = ord($b[2]) ^ ord('S');
$b3 = ord($b[3]) ^ ord('O');
$b = pack("vv", ($b2 | ($b3 << 8)), ($b0 | ($b1 << 8)));
$B = 0xff & 50;
$key = chr(ord($b[0])^$B) . chr(ord($b[1])^$B) . chr($B) . chr(ord($b[3])^$B);
$r = sendrecv($s, $rid, $sid, 1102, $key, 2000);
if (!$r) exit;
$sid = $r['session'];

// --- GET_FREE_SIZES ---
echo "[3] GET_FREE_SIZES\n";
$r = sendrecv($s, $rid, $sid, 50, '', 2000);
$sid = $r['session'];
echo "  DATA HEX:\n";
for ($i = 0; $i < strlen($r['data']); $i += 4) {
    $chunk = substr($r['data'], $i, 4);
    $val = unpack('V', str_pad($chunk, 4, "\x00"))[1];
    $off = intdiv($i, 4);
    printf("    [%2d] %08x = %d  ", $off, $val, $val);
    if (($off+1) % 4 == 0) echo "\n";
}
echo "\n";
if (strlen($r['data']) >= 80) {
    $v = array_values(unpack("V20", substr($r['data'], 0, 80)));
    echo "  PHP parsed: v[1]={$v[1]} v[2]={$v[2]} v[3]={$v[3]} v[4]={$v[4]} v[5]={$v[5]} v[6]={$v[6]} v[7]={$v[7]} v[8]={$v[8]} v[9]={$v[9]} v[10]={$v[10]}\n";
}

// --- GET_USERS simple streaming ---
echo "[4] CMD_USERTEMP_RRQ=9 (streaming)\n";
$r = sendrecv($s, $rid, $sid, 9, '', false);
$sid = $r['session'];
if ($r) {
    echo "  answer cmd={$r['command']} data=".strlen($r['data'])."B\n";
    if ($r['command'] == 1500 && strlen($r['data']) >= 4) {
        $total = unpack('V', substr($r['data'], 0, 4))[1];
        echo "  PREPARE_DATA total={$total}\n";
        // Leer datagramas restantes
        $blob = $r['data'];
        $leido = strlen($r['data']) - 8; // data excluye header
        // fmt: header response to UDP is embedded in the packet
        // Let's just keep reading datagrams
        for ($x = 0; $x < 30; $x++) {
            $r2 = @fread($s, 65536);
            if ($r2 === '' || $r2 === false) {
                $meta = stream_get_meta_data($s);
                if ($meta['timed_out']) { echo "  timeout despues de datagramas extra\n"; break; }
                continue;
            }
            $h2 = unpack("v4", $r2);
            $d2 = substr($r2, 8);
            $sid = $h2[3];
            $rid = $h2[4];
            echo "  extra: cmd={$h2[1]} data=".strlen($d2)."B\n";
            $blob .= $d2;
            if ($h2[1] == 2000) break;
        }
        echo "  blob total=" . strlen($blob) . "B\n";
    }
}

echo "\n=== Fin ===\n";
fclose($s);
