<?php
// Cifrado de secretos (API key de Claude) con AES-256-GCM.
declare(strict_types=1);

function app_key(): string
{
    $hex = (string)(config()['app_key'] ?? '');
    if (!preg_match('/^[0-9a-fA-F]{64}$/', $hex)) {
        throw new RuntimeException('app_key de config.php no es válida (deben ser 64 caracteres hexadecimales).');
    }
    return hex2bin($hex);
}

function encrypt_secret(string $plain): string
{
    $iv = random_bytes(12);
    $tag = '';
    $cipher = openssl_encrypt($plain, 'aes-256-gcm', app_key(), OPENSSL_RAW_DATA, $iv, $tag);
    if ($cipher === false) {
        throw new RuntimeException('No se pudo cifrar');
    }
    return 'v1:' . base64_encode($iv . $tag . $cipher);
}

function decrypt_secret(?string $stored): ?string
{
    if (!$stored || strpos($stored, 'v1:') !== 0) {
        return null;
    }
    $raw = base64_decode(substr($stored, 3), true);
    if ($raw === false || strlen($raw) < 29) {
        return null;
    }
    $iv = substr($raw, 0, 12);
    $tag = substr($raw, 12, 16);
    $cipher = substr($raw, 28);
    $plain = openssl_decrypt($cipher, 'aes-256-gcm', app_key(), OPENSSL_RAW_DATA, $iv, $tag);
    return $plain === false ? null : $plain;
}

function mask_secret(?string $plain): ?string
{
    if (!$plain) {
        return null;
    }
    return substr($plain, 0, 7) . '…' . substr($plain, -4);
}
