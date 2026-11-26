<?php
// Sesiones con token en cookie (duran 60 días, ideal para la PWA en el móvil).
declare(strict_types=1);

const AUTH_COOKIE = 'menus_auth';
const AUTH_DAYS = 60;

function auth_start(int $userId): void
{
    $token = bin2hex(random_bytes(32));
    $expires = time() + AUTH_DAYS * 86400;
    q('INSERT INTO auth_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)', [
        $userId, hash('sha256', $token), date('Y-m-d H:i:s', $expires),
    ]);
    // Limpieza de tokens caducados de vez en cuando
    if (random_int(1, 20) === 1) {
        q('DELETE FROM auth_tokens WHERE expires_at < NOW()');
    }
    setcookie(AUTH_COOKIE, $token, [
        'expires' => $expires,
        'path' => '/',
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function auth_end(): void
{
    $token = $_COOKIE[AUTH_COOKIE] ?? '';
    if ($token !== '') {
        q('DELETE FROM auth_tokens WHERE token_hash = ?', [hash('sha256', $token)]);
    }
    setcookie(AUTH_COOKIE, '', ['expires' => time() - 3600, 'path' => '/', 'secure' => is_https(), 'httponly' => true, 'samesite' => 'Lax']);
}

function current_user(): ?array
{
    static $user = false;
    if ($user !== false) {
        return $user;
    }
    $user = null;
    $token = $_COOKIE[AUTH_COOKIE] ?? '';
    if (is_string($token) && preg_match('/^[0-9a-f]{64}$/', $token)) {
        $user = q_one(
            'SELECT u.id, u.name, u.email, u.family_id, u.role, u.notes
               FROM auth_tokens t JOIN users u ON u.id = t.user_id
              WHERE t.token_hash = ? AND t.expires_at > NOW()',
            [hash('sha256', $token)]
        );
    }
    return $user;
}

function require_user(): array
{
    $u = current_user();
    if (!$u) {
        fail('Tienes que iniciar sesión', 401);
    }
    return $u;
}

function require_family(): array
{
    $u = require_user();
    if (!$u['family_id']) {
        fail('Primero crea una familia o únete a una', 409);
    }
    return $u;
}

function require_admin(): array
{
    $u = require_family();
    if ($u['role'] !== 'admin') {
        fail('Solo el administrador de la familia puede hacer esto', 403);
    }
    return $u;
}
