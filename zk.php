<?php
/**
 * ZKClient — Cliente del protocolo de pull de ZKTeco (puerto 4370).
 * Implementacion UDP/TCP replicando pyzk. Sin dependencias externas.
 */

class ZKException extends Exception {}

class ZKClient
{
    const CMD_ATTLOG_RRQ       = 13;
    const CMD_USERTEMP_RRQ     = 9;
    const CMD_GET_FREE_SIZES   = 50;
    const CMD_CONNECT          = 1000;
    const CMD_EXIT             = 1001;
    const CMD_ENABLEDEVICE     = 1002;
    const CMD_DISABLEDEVICE    = 1003;
    const CMD_AUTH             = 1102;
    const CMD_PREPARE_DATA     = 1500;
    const CMD_DATA             = 1501;
    const CMD_FREE_DATA        = 1502;
    const CMD_ACK_OK           = 2000;
    const CMD_ACK_UNAUTH       = 2005;
    const TOP1 = 0x5050;
    const TOP2 = 0x7282;
    const USHRT_MAX = 65535;

    private $sock = null;
    private $ip;
    private $port;
    private $password;
    private $timeout;
    private $session_id = 0;
    private $reply_id = 65534;
    private $use_tcp = false;
    private $use_udp = true;

    public $is_connect = false;
    public $is_enabled = true;
    public $users_count   = 0;
    public $records_count = 0;
    public $fingers_count = 0;
    public $rec_cap       = 0;
    public $users_cap     = 0;
    public $fingers_cap   = 0;

    public function __construct($ip, $port = 4370, $password = 0, $timeout = 10)
    {
        $this->ip      = $ip;
        $this->port    = (int) $port;
        $this->password = (int) $password;
        $this->timeout = (int) $timeout;
    }

    /* ------------------------------------------------------------------ *
     *  Checksum (replica exacta de pyzk)                                  *
     * ------------------------------------------------------------------ */

    private function checksum($frame)
    {
        $cs = 0;
        $l  = strlen($frame);
        for ($i = 0; $i + 1 < $l; $i += 2) {
            $w = ord($frame[$i]) | (ord($frame[$i + 1]) << 8);
            $cs += $w;
            if ($cs > self::USHRT_MAX) {
                $cs -= self::USHRT_MAX;
            }
        }
        if ($l % 2) {
            $cs += ord($frame[$l - 1]);
        }
        while ($cs > self::USHRT_MAX) {
            $cs -= self::USHRT_MAX;
        }
        $cs = ~$cs;
        while ($cs < 0) {
            $cs += self::USHRT_MAX;
        }
        return $cs;
    }

    /* ------------------------------------------------------------------ *
     *  Construccion de trama (frame)                                     *
     * ------------------------------------------------------------------ */

    private function makeFrame($command, $payload = '')
    {
        // checksum se calcula con el reply_id ACTUAL
        $buf = pack('vvvv', $command, 0, $this->session_id, $this->reply_id) . $payload;
        $cs  = $this->checksum($buf);
        // el header final usa reply_id+1 (sin modificar el valor almacenado)
        $reply = $this->reply_id + 1;
        if ($reply >= self::USHRT_MAX) {
            $reply -= self::USHRT_MAX;
        }
        return pack('vvvv', $command, $cs, $this->session_id, $reply) . $payload;
    }

    /* ------------------------------------------------------------------ *
     *  Apertura de socket                                                *
     * ------------------------------------------------------------------ */

    private function openSocket()
    {
        $errno = 0; $errstr = '';
        $proto = $this->use_tcp ? 'tcp' : 'udp';
        $this->sock = @stream_socket_client(
            "$proto://{$this->ip}:{$this->port}",
            $errno, $errstr, $this->timeout, STREAM_CLIENT_CONNECT
        );
        if ($this->sock === false) {
            throw new ZKException("No se pudo abrir socket {$proto}: {$errstr}");
        }
        stream_set_timeout($this->sock, $this->timeout, 0);
    }

    /* ------------------------------------------------------------------ *
     *  Enviar                                                             *
     * ------------------------------------------------------------------ */

    private function sendFrame($command, $payload = '')
    {
        $frame = $this->makeFrame($command, $payload);

        if ($this->use_tcp) {
            $top = pack('vvV', self::TOP1, self::TOP2, strlen($frame));
            $w = @fwrite($this->sock, $top . $frame);
        } else {
            $w = @fwrite($this->sock, $frame);
        }
        if ($w === false || $w === 0) {
            throw new ZKException("No se pudo enviar comando {$command}");
        }

        // Guardar el reply_id que se envio (reply_id+1 del makeFrame)
        $sent_reply = unpack('v', substr($frame, 6, 2))[1];
        $this->reply_id = $sent_reply;
    }

    /* ------------------------------------------------------------------ *
     *  Recibir UDP                                                        *
     * ------------------------------------------------------------------ */

    private function recvUdp()
    {
        $deadline = microtime(true) + $this->timeout;
        while (microtime(true) < $deadline) {
            $raw = @fread($this->sock, 65536);
            if ($raw === false || $raw === '') {
                $meta = stream_get_meta_data($this->sock);
                if ($meta['timed_out']) {
                    throw new ZKException('Tiempo de espera agotado esperando respuesta (UDP).');
                }
                usleep(20000);
                continue;
            }
            return $this->parseFrame($raw);
        }
        throw new ZKException('No se recibio respuesta del dispositivo (UDP).');
    }

    /* ------------------------------------------------------------------ *
     *  Recibir TCP                                                        *
     * ------------------------------------------------------------------ */

    private function recvTcp()
    {
        // TCP: top header (8 bytes) + frame body
        $top = $this->readN(8);
        $t   = unpack('vvV', $top);
        if ($t[1] !== self::TOP1 || $t[2] !== self::TOP2) {
            throw new ZKException('Cabecera TCP no valida.');
        }
        $len = $t[3];
        if ($len < 8) {
            throw new ZKException('Trama TCP muy corta.');
        }
        $body = $this->readN($len - 8);
        $full = substr($top, 8) . $body;
        return $this->parseFrame($full);
    }

    private function readN($n)
    {
        $buf = '';
        while (strlen($buf) < $n) {
            $c = @fread($this->sock, $n - strlen($buf));
            if ($c === false || $c === '') {
                throw new ZKException('La conexion TCP se cerro.');
            }
            $buf .= $c;
        }
        return $buf;
    }

    private function parseFrame($raw)
    {
        if (strlen($raw) < 8) {
            throw new ZKException('Trama demasiado corta (' . strlen($raw) . ' bytes).');
        }
        $h = unpack('v4', substr($raw, 0, 8));
        return array(
            'command'  => $h[1],
            'checksum' => $h[2],
            'session'  => $h[3],
            'reply'    => $h[4],
            'data'     => substr($raw, 8),
        );
    }

    /* ------------------------------------------------------------------ *
     *  Enviar + Recibir (command)                                         *
     * ------------------------------------------------------------------ */

    private function command($cmd, $payload = '')
    {
        if (!$this->is_connect && $cmd !== self::CMD_CONNECT && $cmd !== self::CMD_AUTH) {
            throw new ZKException('No hay conexion activa.');
        }

        $this->sendFrame($cmd, $payload);

        $resp = $this->use_tcp ? $this->recvTcp() : $this->recvUdp();

        // Actualizar sesion y reply segun la respuesta del dispositivo
        $this->session_id = $resp['session'];
        $this->reply_id   = $resp['reply'];

        return $resp;
    }

    /* ------------------------------------------------------------------ *
     *  Comm key (MakeKey de zkemsdk.c)                                    *
     * ------------------------------------------------------------------ */

    private function makeCommKey($key, $session_id)
    {
        $key  = intval($key);
        $sid  = intval($session_id);
        $k = 0;
        for ($i = 0; $i < 32; $i++) {
            $k = ($key & (1 << $i)) ? (($k << 1) | 1) : ($k << 1);
        }
        $k = ($k + $sid) & 0xFFFFFFFF;
        $b = pack('V', $k);
        $b0 = ord($b[0]) ^ ord('Z');
        $b1 = ord($b[1]) ^ ord('K');
        $b2 = ord($b[2]) ^ ord('S');
        $b3 = ord($b[3]) ^ ord('O');
        $b  = pack('vv', ($b2 | ($b3 << 8)), ($b0 | ($b1 << 8)));
        $B  = 0xff & 50;
        return chr(ord($b[0]) ^ $B) . chr(ord($b[1]) ^ $B) . chr($B) . chr(ord($b[3]) ^ $B);
    }

    /* ------------------------------------------------------------------ *
     *  Conexion                                                           *
     * ------------------------------------------------------------------ */

    public function connect()
    {
        $errors = array();

        foreach (array(true, false) as $try_udp) {
            $this->use_udp = $try_udp;
            $this->use_tcp = !$try_udp;

            try {
                $this->session_id = 0;
                $this->reply_id   = self::USHRT_MAX - 1;
                $this->openSocket();

                // CMD_CONNECT
                $resp = $this->command(self::CMD_CONNECT);
                $this->session_id = $resp['session'];

                // AUTH si se requiere
                if ($resp['command'] === self::CMD_ACK_UNAUTH) {
                    $key = $this->makeCommKey($this->password, $this->session_id);
                    $resp = $this->command(self::CMD_AUTH, $key);
                }

                // Verificar respuesta
                $ok = in_array($resp['command'], array(
                    self::CMD_ACK_OK, self::CMD_CONNECT,
                    self::CMD_DATA, self::CMD_PREPARE_DATA
                ));
                if ($ok) {
                    $this->is_connect = true;
                    return true;
                }

                throw new ZKException('Respuesta invalida: cmd=' . $resp['command']);
            } catch (ZKException $e) {
                $errors[] = ($try_udp ? 'UDP' : 'TCP') . ': ' . $e->getMessage();
                $this->closeSocket();
            }
        }

        throw new ZKException('No se pudo conectar. ' . implode(' | ', $errors));
    }

    private function closeSocket()
    {
        if ($this->sock) {
            @fclose($this->sock);
            $this->sock = null;
        }
        $this->is_connect = false;
    }

    public function disable()
    {
        $r = $this->command(self::CMD_DISABLEDEVICE);
        if ($r['command'] === self::CMD_ACK_OK) $this->is_enabled = false;
    }

    public function enable()
    {
        $r = $this->command(self::CMD_ENABLEDEVICE);
        if ($r['command'] === self::CMD_ACK_OK) $this->is_enabled = true;
    }

    public function disconnect()
    {
        if ($this->sock) {
            try { $this->command(self::CMD_EXIT); } catch (\Exception $e) {}
            $this->closeSocket();
        }
    }

    /* ------------------------------------------------------------------ *
     *  Tamanos de memoria del dispositivo                                 *
     * ------------------------------------------------------------------ */

    public function readSizes()
    {
        $r = $this->command(self::CMD_GET_FREE_SIZES);
        $data = $r['data'];
        if (strlen($data) < 80) {
            throw new ZKException('Respuesta de tamanos no valida (' . strlen($data) . 'B, cmd=' . $r['command'] . ')');
        }
        $v = array_values(unpack('V20', substr($data, 0, 80)));
        // pyzk 0-indexed: users=f[4], fingers=f[6], records=f[8],
        //   cards=f[12], fingers_cap=f[14], users_cap=f[15], rec_cap=f[16]
        // array_values() convierte a 0-indexed
        $this->users_count   = $v[4];
        $this->fingers_count = $v[6];
        $this->records_count = $v[8];
        $this->rec_cap       = $v[16];
        $this->users_cap     = $v[15];
        $this->fingers_cap   = $v[14];
        return $this;
    }

    /* ------------------------------------------------------------------ *
     *  Streaming de datos (legacy 1500/1501)                              *
     * ------------------------------------------------------------------ */

    private function streamData($command)
    {
        $r = $this->command($command);

        // Primer datagrama: PREPARE_DATA con tam total, o DATA directo
        if ($r['command'] === self::CMD_DATA) {
            return $r['data'];
        }

        if ($r['command'] !== self::CMD_PREPARE_DATA) {
            throw new ZKException('Respuesta inesperada: cmd=' . $r['command']);
        }

        $d = $r['data'];
        $total = (strlen($d) >= 4) ? unpack('V', substr($d, 0, 4))[1] : 0;
        $blob = $d;

        // Leer datagramas restantes hasta completar el tam total
        $deadline = microtime(true) + $this->timeout;
        while (strlen($blob) < 8 + $total && microtime(true) < $deadline) {
            try {
                $r2 = $this->recvUdp();
            } catch (ZKException $e) {
                // timeout es normal al final
                break;
            }
            $this->session_id = $r2['session'];
            $this->reply_id   = $r2['reply'];

            if ($r2['command'] === self::CMD_DATA) {
                $blob .= $r2['data'];
            } elseif ($r2['command'] === self::CMD_ACK_OK) {
                break;
            } elseif ($r2['command'] === self::CMD_PREPARE_DATA) {
                $blob .= $r2['data'];
            }
        }

        // Liberar buffer
        try { $this->command(self::CMD_FREE_DATA); } catch (\Exception $e) {}
        return $blob;
    }

    /* ------------------------------------------------------------------ *
     *  Decodificacion de tiempo                                           *
     * ------------------------------------------------------------------ */

    private static function decodeTime($t4)
    {
        $t = unpack('V', $t4)[1];
        $sec  = $t % 60; $t = intdiv($t, 60);
        $min  = $t % 60; $t = intdiv($t, 60);
        $hour = $t % 24; $t = intdiv($t, 24);
        $day  = $t % 31 + 1; $t = intdiv($t, 31);
        $mon  = $t % 12 + 1; $t = intdiv($t, 12);
        $year = $t + 2000;
        return sprintf('%04d-%02d-%02d %02d:%02d:%02d', $year, $mon, $day, $hour, $min, $sec);
    }

    private static function cleanStr($s)
    {
        $s = trim($s, "\x00 ");
        $p = strpos($s, "\x00");
        if ($p !== false) $s = substr($s, 0, $p);
        return $s;
    }

    /* ------------------------------------------------------------------ *
     *  Usuarios                                                           *
     * ------------------------------------------------------------------ */

    public function getUsers()
    {
        $this->readSizes();
        if ($this->users_count === 0) {
            return array();
        }

        $blob = $this->streamData(self::CMD_USERTEMP_RRQ);
        if (strlen($blob) < 6) {
            return array();
        }

        // Saltar 4 bytes de header de tamanio
        $total = unpack('V', substr($blob, 0, 4))[1];
        $data  = substr($blob, 4);

        $packetSize = ($this->users_count > 0 && $total > 0 && $total % $this->users_count === 0)
            ? intdiv($total, $this->users_count) : 28;

        if (!in_array($packetSize, array(28, 72)) && strlen($data) > 0) {
            $packetSize = (strlen($data) % 72 === 0) ? 72 : 28;
        }

        $users = array();
        while (strlen($data) >= $packetSize) {
            $rec = substr($data, 0, $packetSize);
            if ($packetSize === 72) {
                $f = unpack('vuid/Cpriv/A8pass/A24name/Vcard/x/A7group/x/A24userid', $rec);
                $uid    = (int) $f['uid'];
                $userId = trim($f['userid'], "\x00 ");
                $name   = self::cleanStr($f['name']);
            } else {
                $f = unpack('vuid/Cpriv/A5pass/A8name/Vcard/x/Cgroup/vtz/Vuserid', $rec);
                $uid    = (int) $f['uid'];
                $userId = trim((string)$f['userid'], "\x00 ");
                $name   = self::cleanStr($f['name']);
            }
            $data = substr($data, $packetSize);
            if ($userId === '') $userId = (string) $uid;
            if ($name   === '') $name   = 'Usuario-' . $userId;

            $users[$userId] = array(
                'uid'       => $uid,
                'user_id'   => $userId,
                'name'      => $name,
                'privilege' => isset($f['priv']) ? (int) $f['priv'] : 0,
                'card'      => isset($f['card']) ? (int) $f['card'] : 0,
            );
        }
        return $users;
    }

    /* ------------------------------------------------------------------ *
     *  Asistencia                                                         *
     * ------------------------------------------------------------------ */

    public function getAttendance()
    {
        $this->readSizes();
        if ($this->records_count === 0) {
            return array();
        }

        $blob = $this->streamData(self::CMD_ATTLOG_RRQ);
        if (strlen($blob) < 4) {
            return array();
        }

        $total = unpack('V', substr($blob, 0, 4))[1];
        $data  = substr($blob, 4);

        // Determinar tam de registro: records_count del dispositivo o heuristica
        $sz = 0;
        if ($this->records_count > 0 && $total > 0 && $total % $this->records_count === 0) {
            $sz = intdiv($total, $this->records_count);
        }
        if (!in_array($sz, array(8, 16, 40)) && $this->records_count > 0 && strlen($data) > 0) {
            $sz = intdiv(strlen($data), $this->records_count);
        }
        if (!in_array($sz, array(8, 16, 40))) {
            foreach (array(8, 16, 40) as $c) {
                if (strlen($data) > 0 && strlen($data) % $c === 0) { $sz = $c; break; }
            }
        }
        if ($sz === 0) {
            return array();
        }

        $attendances = array();
        while (strlen($data) >= $sz) {
            $rec = substr($data, 0, $sz);
            if ($sz === 8) {
                $uid       = (int) unpack('v', substr($rec, 0, 2))[1];
                $status    = ord($rec[2]);
                $timestamp = self::decodeTime(substr($rec, 3, 4));
                $punch     = ord($rec[7]);
                $userId    = (string) $uid;
            } elseif ($sz === 16) {
                $userId    = (string) unpack('V', substr($rec, 0, 4))[1];
                $uid       = (int) $userId;
                $timestamp = self::decodeTime(substr($rec, 4, 4));
                $status    = ord($rec[8]);
                $punch     = ord($rec[9]);
            } else {
                $uid       = (int) unpack('v', substr($rec, 0, 2))[1];
                $userId    = trim(substr($rec, 2, 24), "\x00 ");
                $status    = ord($rec[26]);
                $timestamp = self::decodeTime(substr($rec, 27, 4));
                $punch     = ord($rec[31]);
                if ($userId === '') $userId = (string) $uid;
            }

            $attendances[] = array(
                'uid'       => $uid,
                'user_id'   => $userId,
                'timestamp' => $timestamp,
                'status'    => $status,
                'punch'     => $punch,
            );
            $data = substr($data, $sz);
        }
        return $attendances;
    }

    /* ------------------------------------------------------------------ *
     *  Labels                                                             *
     * ------------------------------------------------------------------ */

    public static function punchLabel($punch)
    {
        $map = array(
            0 => 'Entrada', 1 => 'Salida',
            2 => 'Salida fuera', 3 => 'Entrada fuera',
            4 => 'Extra entrada', 5 => 'Extra salida',
        );
        return isset($map[$punch]) ? $map[$punch] : "Tipo $punch";
    }

    public static function statusLabel($status)
    {
        $map = array(
            0 => 'Huella', 1 => 'Tarjeta', 2 => 'Clave',
            3 => 'Huella+Clave', 4 => 'Tarjeta+Huella',
            5 => 'Tarjeta+Clave', 6 => 'FP+PWD', 7 => 'All', 8 => 'All',
        );
        return isset($map[$status]) ? $map[$status] : "Verif $status";
    }
}