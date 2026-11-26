<?php
// Carga común: configuración, base de datos, utilidades y sesión.
declare(strict_types=1);

if (PHP_VERSION_ID < 70400) {
    http_response_code(500);
    exit('Esta app necesita PHP 7.4 o superior.');
}

define('APP_ROOT', dirname(__DIR__));

function config(): array
{
    static $cfg = null;
    if ($cfg === null) {
        $file = APP_ROOT . '/config.php';
        if (!is_file($file)) {
            throw new RuntimeException('Falta config.php. Copia config.sample.php como config.php y rellénalo.');
        }
        $cfg = require $file;
    }
    return $cfg;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $c = config()['db'];
        $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $c['host'], (int)($c['port'] ?? 3306), $c['name']);
        $pdo = new PDO($dsn, $c['user'], $c['pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    }
    return $pdo;
}

function q(string $sql, array $params = []): PDOStatement
{
    $st = db()->prepare($sql);
    $st->execute($params);
    return $st;
}

function q_one(string $sql, array $params = []): ?array
{
    $row = q($sql, $params)->fetch();
    return $row === false ? null : $row;
}

function q_all(string $sql, array $params = []): array
{
    return q($sql, $params)->fetchAll();
}

class ApiError extends Exception
{
    public $status;
    public function __construct(string $message, int $status = 400)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

function fail(string $message, int $status = 400): void
{
    throw new ApiError($message, $status);
}

function json_out($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function str_clean($value, int $max = 200): string
{
    $s = trim((string)$value);
    $s = preg_replace('/\s+/u', ' ', $s) ?? '';
    if (function_exists('mb_substr')) {
        return mb_substr($s, 0, $max);
    }
    return substr($s, 0, $max);
}

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        || ((int)($_SERVER['SERVER_PORT'] ?? 0) === 443);
}

// ---------- Secciones del supermercado ----------
const SECTIONS = [
    'Frutas y verduras',
    'Carne',
    'Pescado',
    'Lácteos y huevos',
    'Panadería',
    'Despensa',
    'Congelados',
    'Bebidas',
    'Droguería y limpieza',
    'Otros',
];

const MEALS = ['desayuno', 'comida', 'cena'];

function normalize_section(string $s): string
{
    foreach (SECTIONS as $sec) {
        if (mb_strtolower($sec) === mb_strtolower(trim($s))) {
            return $sec;
        }
    }
    return 'Otros';
}

// Marca que los datos de la familia han cambiado, para que el resto de miembros refresquen.
function bump_version(int $familyId): void
{
    q('UPDATE families SET data_version = data_version + 1 WHERE id = ?', [$familyId]);
}

// Lunes de la semana de una fecha dada (Y-m-d)
function week_monday(?string $date = null): string
{
    $d = $date ? DateTime::createFromFormat('!Y-m-d', $date) : new DateTime('today');
    if (!$d) {
        fail('Fecha no válida');
    }
    $dow = (int)$d->format('N'); // 1 = lunes
    $d->modify('-' . ($dow - 1) . ' days');
    return $d->format('Y-m-d');
}
