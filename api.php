<?php
// API JSON de la app. Todas las llamadas: api.php?action=NOMBRE (GET para leer, POST con JSON para escribir).
declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/crypto.php';
require __DIR__ . '/lib/auth.php';
require __DIR__ . '/lib/claude.php';
require __DIR__ . '/lib/shopping.php';

$action = (string)($_GET['action'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$in = [];
if ($method === 'POST') {
    // Protección CSRF básica: solo aceptamos JSON enviado por nuestra propia app.
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'menus-app') {
        json_out(['error' => 'Petición no válida'], 400);
    }
    $in = json_decode((string)file_get_contents('php://input'), true) ?: [];
}

const READ_ACTIONS = ['me', 'sync', 'family', 'prefs', 'menu', 'shop'];

try {
    if ($method !== 'POST' && !in_array($action, READ_ACTIONS, true)) {
        fail('Método no permitido', 405);
    }
    $fn = 'act_' . $action;
    if (!preg_match('/^[a-z_]+$/', $action) || !function_exists($fn)) {
        fail('Acción desconocida', 404);
    }
    json_out($fn($in));
} catch (ApiError $e) {
    json_out(['error' => $e->getMessage()], $e->status);
} catch (Throwable $e) {
    error_log('[menus-app] ' . $e);
    $debug = false;
    try {
        $debug = !empty(config()['debug']);
    } catch (Throwable $ignored) {
    }
    json_out(['error' => $debug ? $e->getMessage() : 'Error interno del servidor'], 500);
}

// ================= Utilidades =================

function load_family(int $id): array
{
    $f = q_one('SELECT * FROM families WHERE id = ?', [$id]);
    if (!$f) {
        fail('Familia no encontrada', 404);
    }
    return $f;
}

function new_invite_code(): string
{
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do {
        $code = '';
        for ($i = 0; $i < 8; $i++) {
            $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
    } while (q_one('SELECT id FROM families WHERE invite_code = ?', [$code]));
    return $code;
}

function user_public(array $u): array
{
    return [
        'id' => (int)$u['id'], 'name' => $u['name'], 'email' => $u['email'],
        'family_id' => $u['family_id'] ? (int)$u['family_id'] : null, 'role' => $u['role'], 'notes' => (string)$u['notes'],
    ];
}

function get_or_create_menu(int $familyId, string $week): array
{
    $m = q_one('SELECT * FROM menus WHERE family_id = ? AND week_start = ?', [$familyId, $week]);
    if (!$m) {
        q('INSERT IGNORE INTO menus (family_id, week_start) VALUES (?, ?)', [$familyId, $week]);
        $m = q_one('SELECT * FROM menus WHERE family_id = ? AND week_start = ?', [$familyId, $week]);
    }
    return $m;
}

function load_item_for_user(array $u, int $id): array
{
    $it = q_one(
        'SELECT i.*, m.family_id, m.week_start FROM menu_items i JOIN menus m ON m.id = i.menu_id WHERE i.id = ?',
        [$id]
    );
    if (!$it || (int)$it['family_id'] !== (int)$u['family_id']) {
        fail('Plato no encontrado', 404);
    }
    return $it;
}

function item_public(array $it): array
{
    return [
        'id' => (int)$it['id'], 'day' => (int)$it['day'], 'meal' => $it['meal'], 'dish' => $it['dish'],
        'notes' => (string)$it['notes'],
        'ingredients' => $it['ingredients'] === null ? null : (json_decode($it['ingredients'], true) ?: []),
    ];
}

function family_member_count(int $familyId): int
{
    return (int)q_one('SELECT COUNT(*) c FROM users WHERE family_id = ?', [$familyId])['c'];
}

function ai_prepare(): void
{
    @set_time_limit(300);
    @ignore_user_abort(true);
}

// ================= Cuenta =================

function act_me(): array
{
    $u = current_user();
    return ['user' => $u ? user_public($u) : null];
}

function act_register(array $in): array
{
    $name = str_clean($in['name'] ?? '', 80);
    $email = strtolower(str_clean($in['email'] ?? '', 190));
    $pass = (string)($in['password'] ?? '');
    if ($name === '') {
        fail('Escribe tu nombre');
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        fail('El email no es válido');
    }
    if (strlen($pass) < 8) {
        fail('La contraseña debe tener al menos 8 caracteres');
    }
    if (q_one('SELECT id FROM users WHERE email = ?', [$email])) {
        fail('Ya existe una cuenta con ese email');
    }
    q('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [$name, $email, password_hash($pass, PASSWORD_DEFAULT)]);
    $id = (int)db()->lastInsertId();
    auth_start($id);
    $result = ['user' => user_public(q_one('SELECT * FROM users WHERE id = ?', [$id]))];
    // Si venía de un enlace de invitación, se une directamente
    if (!empty($in['invite'])) {
        $f = q_one('SELECT id FROM families WHERE invite_code = ?', [strtoupper(trim((string)$in['invite']))]);
        if ($f) {
            q('UPDATE users SET family_id = ?, role = "member" WHERE id = ?', [$f['id'], $id]);
            bump_version((int)$f['id']);
            $result['user'] = user_public(q_one('SELECT * FROM users WHERE id = ?', [$id]));
        }
    }
    return $result;
}

function act_login(array $in): array
{
    $email = strtolower(str_clean($in['email'] ?? '', 190));
    $u = q_one('SELECT * FROM users WHERE email = ?', [$email]);
    if (!$u || !password_verify((string)($in['password'] ?? ''), $u['password_hash'])) {
        usleep(400000); // frena intentos por fuerza bruta
        fail('Email o contraseña incorrectos', 401);
    }
    if (password_needs_rehash($u['password_hash'], PASSWORD_DEFAULT)) {
        q('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash((string)$in['password'], PASSWORD_DEFAULT), $u['id']]);
    }
    auth_start((int)$u['id']);
    return ['user' => user_public($u)];
}

function act_logout(): array
{
    auth_end();
    return ['ok' => true];
}

function act_profile_update(array $in): array
{
    $u = require_user();
    $name = str_clean($in['name'] ?? $u['name'], 80);
    if ($name === '') {
        fail('Escribe tu nombre');
    }
    $notes = str_clean($in['notes'] ?? '', 500);
    q('UPDATE users SET name = ?, notes = ? WHERE id = ?', [$name, $notes, $u['id']]);
    if (!empty($in['new_password'])) {
        $row = q_one('SELECT password_hash FROM users WHERE id = ?', [$u['id']]);
        if (!password_verify((string)($in['current_password'] ?? ''), $row['password_hash'])) {
            fail('La contraseña actual no es correcta');
        }
        if (strlen((string)$in['new_password']) < 8) {
            fail('La nueva contraseña debe tener al menos 8 caracteres');
        }
        q('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash((string)$in['new_password'], PASSWORD_DEFAULT), $u['id']]);
    }
    if ($u['family_id']) {
        bump_version((int)$u['family_id']);
    }
    return ['user' => user_public(q_one('SELECT * FROM users WHERE id = ?', [$u['id']]))];
}

// ================= Familia =================

function act_family_create(array $in): array
{
    $u = require_user();
    if ($u['family_id']) {
        fail('Ya perteneces a una familia');
    }
    $name = str_clean($in['name'] ?? '', 100) ?: ('Familia de ' . $u['name']);
    q('INSERT INTO families (name, invite_code) VALUES (?, ?)', [$name, new_invite_code()]);
    $fid = (int)db()->lastInsertId();
    q('UPDATE users SET family_id = ?, role = "admin" WHERE id = ?', [$fid, $u['id']]);
    return ['ok' => true];
}

function act_family_join(array $in): array
{
    $u = require_user();
    if ($u['family_id']) {
        fail('Ya perteneces a una familia. Sal de ella primero.');
    }
    $code = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string)($in['code'] ?? '')) ?? '');
    $f = q_one('SELECT id FROM families WHERE invite_code = ?', [$code]);
    if (!$f) {
        fail('Ese código de invitación no existe');
    }
    q('UPDATE users SET family_id = ?, role = "member" WHERE id = ?', [$f['id'], $u['id']]);
    bump_version((int)$f['id']);
    return ['ok' => true];
}

function act_family_leave(): array
{
    $u = require_family();
    $fid = (int)$u['family_id'];
    q('UPDATE users SET family_id = NULL, role = "member" WHERE id = ?', [$u['id']]);
    $left = q_all('SELECT id, role FROM users WHERE family_id = ? ORDER BY id', [$fid]);
    if (!$left) {
        q('DELETE FROM families WHERE id = ?', [$fid]); // último miembro: se borra la familia y sus datos
    } else {
        $hasAdmin = false;
        foreach ($left as $m) {
            $hasAdmin = $hasAdmin || $m['role'] === 'admin';
        }
        if (!$hasAdmin) {
            q('UPDATE users SET role = "admin" WHERE id = ?', [$left[0]['id']]);
        }
        bump_version($fid);
    }
    return ['ok' => true];
}

function act_family(): array
{
    $u = require_family();
    $f = load_family((int)$u['family_id']);
    $members = q_all('SELECT id, name, role, notes FROM users WHERE family_id = ? ORDER BY id', [$f['id']]);
    $key = decrypt_secret($f['api_key_enc']);
    $base = rtrim((string)(config()['base_url'] ?? ''), '/');
    return [
        'family' => [
            'id' => (int)$f['id'],
            'name' => $f['name'],
            'invite_code' => $f['invite_code'],
            'invite_link' => $base . '/#/unirse/' . $f['invite_code'],
            'ai_model' => $f['ai_model'],
            'servings' => (int)$f['servings'],
            'meals' => family_meals($f),
            'tips' => (string)$f['tips'],
            'has_api_key' => (bool)$key,
            'api_key_masked' => mask_secret($key),
        ],
        'members' => array_map(function ($m) {
            return ['id' => (int)$m['id'], 'name' => $m['name'], 'role' => $m['role'], 'notes' => (string)$m['notes']];
        }, $members),
        'models' => CLAUDE_MODELS,
        'sections' => SECTIONS,
        'me' => user_public($u),
    ];
}

function act_family_update(array $in): array
{
    $u = require_family();
    $f = load_family((int)$u['family_id']);
    // Cualquier miembro puede editar los tips; el resto solo el administrador.
    if (array_key_exists('tips', $in)) {
        $tips = trim((string)$in['tips']);
        q('UPDATE families SET tips = ? WHERE id = ?', [function_exists('mb_substr') ? mb_substr($tips, 0, 3000) : substr($tips, 0, 3000), $f['id']]);
    }
    $adminFields = array_intersect(array_keys($in), ['name', 'ai_model', 'servings', 'meals']);
    if ($adminFields) {
        if ($u['role'] !== 'admin') {
            fail('Solo el administrador puede cambiar estos ajustes', 403);
        }
        $name = str_clean($in['name'] ?? $f['name'], 100) ?: $f['name'];
        $model = array_key_exists($in['ai_model'] ?? '', CLAUDE_MODELS) ? $in['ai_model'] : $f['ai_model'];
        $servings = max(0, min(20, (int)($in['servings'] ?? $f['servings'])));
        $meals = isset($in['meals']) ? array_values(array_intersect(MEALS, (array)$in['meals'])) : family_meals($f);
        if (!$meals) {
            fail('Elige al menos una comida del día');
        }
        q('UPDATE families SET name = ?, ai_model = ?, servings = ?, meals = ? WHERE id = ?', [$name, $model, $servings, implode(',', $meals), $f['id']]);
    }
    bump_version((int)$f['id']);
    return act_family();
}

function act_family_apikey(array $in): array
{
    $u = require_admin();
    $key = trim((string)($in['api_key'] ?? ''));
    if ($key === '') {
        q('UPDATE families SET api_key_enc = NULL WHERE id = ?', [$u['family_id']]);
    } else {
        if (!preg_match('/^sk-ant-[A-Za-z0-9_\-]{20,}$/', $key)) {
            fail('Eso no parece una API key de Claude (empieza por sk-ant-)');
        }
        q('UPDATE families SET api_key_enc = ? WHERE id = ?', [encrypt_secret($key), $u['family_id']]);
    }
    bump_version((int)$u['family_id']);
    return act_family();
}

function act_family_new_code(): array
{
    $u = require_admin();
    q('UPDATE families SET invite_code = ? WHERE id = ?', [new_invite_code(), $u['family_id']]);
    return act_family();
}

function act_family_remove_member(array $in): array
{
    $u = require_admin();
    $id = (int)($in['user_id'] ?? 0);
    if ($id === (int)$u['id']) {
        fail('Para salir tú, usa "Salir de la familia"');
    }
    q('UPDATE users SET family_id = NULL, role = "member" WHERE id = ? AND family_id = ?', [$id, $u['family_id']]);
    q('DELETE FROM auth_tokens WHERE user_id = ?', [$id]);
    bump_version((int)$u['family_id']);
    return act_family();
}

function act_family_make_admin(array $in): array
{
    $u = require_admin();
    q('UPDATE users SET role = "admin" WHERE id = ? AND family_id = ?', [(int)($in['user_id'] ?? 0), $u['family_id']]);
    bump_version((int)$u['family_id']);
    return act_family();
}

// ================= Preferencias =================

function act_prefs(): array
{
    $u = require_family();
    $members = family_members_with_prefs((int)$u['family_id']);
    // Incluimos ids de las preferencias para poder borrarlas
    $rows = q_all(
        'SELECT p.id, p.user_id, p.kind, p.item FROM preferences p JOIN users u ON u.id = p.user_id WHERE u.family_id = ? ORDER BY p.item',
        [$u['family_id']]
    );
    $out = [];
    foreach ($members as $m) {
        $out[$m['id']] = ['id' => (int)$m['id'], 'name' => $m['name'], 'notes' => (string)$m['notes'], 'like' => [], 'dislike' => [], 'allergy' => []];
    }
    foreach ($rows as $r) {
        $out[$r['user_id']][$r['kind']][] = ['id' => (int)$r['id'], 'item' => $r['item']];
    }
    return ['members' => array_values($out), 'me' => (int)$u['id']];
}

function act_pref_add(array $in): array
{
    $u = require_family();
    $kind = (string)($in['kind'] ?? '');
    if (!in_array($kind, ['like', 'dislike', 'allergy'], true)) {
        fail('Tipo no válido');
    }
    // Se pueden añadir varias separadas por comas
    $items = array_filter(array_map(function ($s) {
        return str_clean($s, 120);
    }, explode(',', (string)($in['item'] ?? ''))));
    if (!$items) {
        fail('Escribe algo');
    }
    // Por defecto, para uno mismo; también se puede para otro miembro de la familia (p.ej. niños sin cuenta propia)
    $target = (int)($in['user_id'] ?? $u['id']);
    if (!q_one('SELECT id FROM users WHERE id = ? AND family_id = ?', [$target, $u['family_id']])) {
        fail('Miembro no encontrado', 404);
    }
    foreach ($items as $item) {
        // Si estaba como "me gusta" y ahora "no me gusta", se mueve
        q('DELETE FROM preferences WHERE user_id = ? AND item = ?', [$target, $item]);
        q('INSERT INTO preferences (user_id, kind, item) VALUES (?, ?, ?)', [$target, $kind, $item]);
    }
    bump_version((int)$u['family_id']);
    return act_prefs();
}

function act_pref_delete(array $in): array
{
    $u = require_family();
    q(
        'DELETE p FROM preferences p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND u.family_id = ?',
        [(int)($in['id'] ?? 0), $u['family_id']]
    );
    bump_version((int)$u['family_id']);
    return act_prefs();
}

// ================= Menú semanal =================

function act_menu(array $in = []): array
{
    $u = require_family();
    $f = load_family((int)$u['family_id']);
    $week = week_monday($in['week'] ?? ($_GET['week'] ?? null));
    $m = q_one('SELECT * FROM menus WHERE family_id = ? AND week_start = ?', [$f['id'], $week]);
    $items = $m ? q_all('SELECT * FROM menu_items WHERE menu_id = ? ORDER BY day, FIELD(meal, "desayuno", "comida", "cena")', [$m['id']]) : [];
    return [
        'week' => $week,
        'meals' => family_meals($f),
        'has_api_key' => !empty($f['api_key_enc']),
        'instructions' => $m ? (string)$m['instructions'] : '',
        'items' => array_map('item_public', $items),
        'missing_ingredients' => count(array_filter($items, function ($i) {
            return $i['ingredients'] === null && $i['dish'] !== '';
        })),
    ];
}

function act_menu_generate(array $in): array
{
    ai_prepare();
    $u = require_family();
    $f = load_family((int)$u['family_id']);
    $week = week_monday($in['week'] ?? null);
    $instructions = trim((string)($in['instructions'] ?? ''));
    $recent = array_column(q_all(
        'SELECT DISTINCT i.dish FROM menu_items i JOIN menus m ON m.id = i.menu_id
          WHERE m.family_id = ? AND m.week_start < ? AND m.week_start >= DATE_SUB(?, INTERVAL 21 DAY) AND i.dish <> ""',
        [$f['id'], $week, $week]
    ), 'dish');

    $days = ai_generate_week($f, $instructions, $recent);
    $meals = family_meals($f);

    $pdo = db();
    $pdo->beginTransaction();
    $menu = get_or_create_menu((int)$f['id'], $week);
    q('UPDATE menus SET instructions = ? WHERE id = ?', [$instructions, $menu['id']]);
    q('DELETE FROM menu_items WHERE menu_id = ?', [$menu['id']]);
    $seen = [];
    foreach ($days as $d) {
        $day = (int)($d['day'] ?? -1);
        if ($day < 0 || $day > 6) {
            continue;
        }
        foreach ($d['meals'] ?? [] as $meal) {
            $mealName = (string)($meal['meal'] ?? '');
            if (!in_array($mealName, $meals, true) || isset($seen["$day-$mealName"])) {
                continue;
            }
            $seen["$day-$mealName"] = true;
            q('INSERT INTO menu_items (menu_id, day, meal, dish, notes, ingredients) VALUES (?, ?, ?, ?, ?, NULL)', [
                $menu['id'], $day, $mealName, str_clean($meal['dish'] ?? '', 200), str_clean($meal['notes'] ?? '', 500),
            ]);
        }
    }
    $pdo->commit();
    bump_version((int)$f['id']);
    return act_menu(['week' => $week]);
}

// Rellena ingredientes que falten, por tandas pequeñas (el cliente llama hasta que no quede ninguno).
function act_menu_ingredients(array $in): array
{
    ai_prepare();
    $u = require_family();
    $f = load_family((int)$u['family_id']);
    $week = week_monday($in['week'] ?? null);
    $m = q_one('SELECT id FROM menus WHERE family_id = ? AND week_start = ?', [$f['id'], $week]);
    if (!$m) {
        return act_menu(['week' => $week]);
    }
    $pending = q_all(
        'SELECT id, dish, notes FROM menu_items WHERE menu_id = ? AND ingredients IS NULL AND dish <> "" ORDER BY day, id LIMIT 6',
        [$m['id']]
    );
    if ($pending) {
        $servings = family_servings($f, family_member_count((int)$f['id']));
        $result = ai_ingredients($f, $pending, $servings);
        foreach ($pending as $p) {
            if (isset($result[(int)$p['id']])) {
                q('UPDATE menu_items SET ingredients = ? WHERE id = ? AND ingredients IS NULL', [
                    json_encode(clean_ingredients($result[(int)$p['id']]), JSON_UNESCAPED_UNICODE), $p['id'],
                ]);
            } else {
                // Para no quedarnos en bucle si Claude omite un plato
                q('UPDATE menu_items SET ingredients = "[]" WHERE id = ? AND ingredients IS NULL', [$p['id']]);
            }
        }
        bump_version((int)$f['id']);
    }
    return act_menu(['week' => $week]);
}

// Guardar un plato a mano (crear o editar un hueco)
function act_item_save(array $in): array
{
    $u = require_family();
    $f = load_family((int)$u['family_id']);
    $dish = str_clean($in['dish'] ?? '', 200);
    $notes = str_clean($in['notes'] ?? '', 500);
    if (!empty($in['id'])) {
        $it = load_item_for_user($u, (int)$in['id']);
        $changed = $it['dish'] !== $dish;
        q('UPDATE menu_items SET dish = ?, notes = ?' . ($changed ? ', ingredients = NULL' : '') . ' WHERE id = ?', [$dish, $notes, $it['id']]);
        $week = $it['week_start'];
    } else {
        $week = week_monday($in['week'] ?? null);
        $day = (int)($in['day'] ?? -1);
        $meal = (string)($in['meal'] ?? '');
        if ($day < 0 || $day > 6 || !in_array($meal, MEALS, true)) {
            fail('Hueco no válido');
        }
        $menu = get_or_create_menu((int)$f['id'], $week);
        q(
            'INSERT INTO menu_items (menu_id, day, meal, dish, notes, ingredients) VALUES (?, ?, ?, ?, ?, NULL)
             ON DUPLICATE KEY UPDATE dish = VALUES(dish), notes = VALUES(notes), ingredients = NULL',
            [$menu['id'], $day, $meal, $dish, $notes]
        );
    }
    bump_version((int)$f['id']);
    return act_menu(['week' => $week]);
}

function act_item_delete(array $in): array
{
    $u = require_family();
    $it = load_item_for_user($u, (int)($in['id'] ?? 0));
    q('DELETE FROM menu_items WHERE id = ?', [$it['id']]);
    bump_version((int)$u['family_id']);
    return act_menu(['week' => $it['week_start']]);
}

function act_item_regenerate(array $in): array
{
    ai_prepare();
    $u = require_family();
    $f = load_family((int)$u['family_id']);
    $it = load_item_for_user($u, (int)($in['id'] ?? 0));
    $week = q_all('SELECT * FROM menu_items WHERE menu_id = ?', [$it['menu_id']]);
    $servings = family_servings($f, family_member_count((int)$f['id']));
    $r = ai_regenerate_dish($f, $week, $it, (string)($in['hint'] ?? ''), $servings);
    q('UPDATE menu_items SET dish = ?, notes = ?, ingredients = ? WHERE id = ?', [
        str_clean($r['dish'] ?? '', 200), str_clean($r['notes'] ?? '', 500),
        json_encode(clean_ingredients($r['ingredients'] ?? []), JSON_UNESCAPED_UNICODE), $it['id'],
    ]);
    bump_version((int)$f['id']);
    return act_menu(['week' => $it['week_start']]);
}

// ================= Lista de la compra =================

function act_shop(): array
{
    $u = require_family();
    $items = q_all(
        'SELECT s.id, s.name, s.quantity, s.section, s.checked, s.source, u.name AS added_by
           FROM shopping_items s LEFT JOIN users u ON u.id = s.created_by
          WHERE s.family_id = ? ORDER BY s.checked, s.name',
        [$u['family_id']]
    );
    foreach ($items as &$i) {
        $i['id'] = (int)$i['id'];
        $i['checked'] = (bool)$i['checked'];
        $i['quantity'] = (string)$i['quantity'];
    }
    return ['items' => $items, 'sections' => SECTIONS];
}

function act_shop_add(array $in): array
{
    $u = require_family();
    $name = str_clean($in['name'] ?? '', 150);
    if ($name === '') {
        fail('Escribe qué hay que comprar');
    }
    q('INSERT INTO shopping_items (family_id, name, quantity, section, source, created_by) VALUES (?, ?, ?, ?, "manual", ?)', [
        $u['family_id'], $name, str_clean($in['quantity'] ?? '', 80), normalize_section((string)($in['section'] ?? 'Otros')), $u['id'],
    ]);
    bump_version((int)$u['family_id']);
    return act_shop();
}

function act_shop_update(array $in): array
{
    $u = require_family();
    $id = (int)($in['id'] ?? 0);
    $row = q_one('SELECT * FROM shopping_items WHERE id = ? AND family_id = ?', [$id, $u['family_id']]);
    if (!$row) {
        fail('Producto no encontrado', 404);
    }
    $name = array_key_exists('name', $in) ? str_clean($in['name'], 150) : $row['name'];
    q('UPDATE shopping_items SET name = ?, quantity = ?, section = ?, checked = ? WHERE id = ?', [
        $name ?: $row['name'],
        array_key_exists('quantity', $in) ? str_clean($in['quantity'], 80) : $row['quantity'],
        array_key_exists('section', $in) ? normalize_section((string)$in['section']) : $row['section'],
        array_key_exists('checked', $in) ? (int)(bool)$in['checked'] : $row['checked'],
        $id,
    ]);
    bump_version((int)$u['family_id']);
    return act_shop();
}

function act_shop_delete(array $in): array
{
    $u = require_family();
    q('DELETE FROM shopping_items WHERE id = ? AND family_id = ?', [(int)($in['id'] ?? 0), $u['family_id']]);
    bump_version((int)$u['family_id']);
    return act_shop();
}

function act_shop_clear_checked(): array
{
    $u = require_family();
    q('DELETE FROM shopping_items WHERE family_id = ? AND checked = 1', [$u['family_id']]);
    bump_version((int)$u['family_id']);
    return act_shop();
}

// Rehace la parte de la lista que viene del menú (lo añadido a mano se conserva)
function act_shop_from_menu(array $in): array
{
    $u = require_family();
    $week = week_monday($in['week'] ?? null);
    $m = q_one('SELECT id FROM menus WHERE family_id = ? AND week_start = ?', [$u['family_id'], $week]);
    if (!$m) {
        fail('Esa semana no tiene menú');
    }
    $all = [];
    $missing = 0;
    foreach (q_all('SELECT ingredients, dish FROM menu_items WHERE menu_id = ?', [$m['id']]) as $row) {
        if ($row['ingredients'] === null) {
            $missing += $row['dish'] !== '' ? 1 : 0;
            continue;
        }
        foreach (json_decode($row['ingredients'], true) ?: [] as $ing) {
            $all[] = $ing;
        }
    }
    if ($missing > 0) {
        fail('Faltan ingredientes de ' . $missing . ' plato(s). Calcúlalos primero desde el menú.', 409);
    }
    $pdo = db();
    $pdo->beginTransaction();
    q('DELETE FROM shopping_items WHERE family_id = ? AND source = "menu" AND checked = 0', [$u['family_id']]);
    foreach (aggregate_ingredients($all) as $i) {
        q('INSERT INTO shopping_items (family_id, name, quantity, section, source, created_by) VALUES (?, ?, ?, ?, "menu", ?)', [
            $u['family_id'], str_clean($i['name'], 150), str_clean($i['quantity'], 80), normalize_section($i['section']), $u['id'],
        ]);
    }
    $pdo->commit();
    bump_version((int)$u['family_id']);
    return act_shop();
}

// ================= Sincronización (polling) =================

function act_sync(): array
{
    $u = current_user();
    if (!$u) {
        return ['v' => 0, 'auth' => false];
    }
    if (!$u['family_id']) {
        return ['v' => 0, 'auth' => true, 'family' => false];
    }
    $f = q_one('SELECT data_version FROM families WHERE id = ?', [$u['family_id']]);
    return ['v' => (int)($f['data_version'] ?? 0), 'auth' => true, 'family' => true];
}
