<?php
// Integración con la API de Claude (HTTP directo con cURL, sin Composer,
// para que funcione en cualquier hosting compartido).
declare(strict_types=1);

const CLAUDE_MODELS = [
    'claude-opus-5-5' => 'Claude Opus 5.5 (mejor calidad, recomendado)',
    'claude-sonnet-5-5' => 'Claude Sonnet 5.5 (más barato)',
    'claude-haiku-5-5' => 'Claude Haiku 5.5 (el más barato y rápido)',
];
const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

function family_api_key(array $family): string
{
    $key = decrypt_secret($family['api_key_enc'] ?? null);
    if (!$key) {
        fail('Falta la API key de Claude. Añádela en Ajustes de la familia.', 409);
    }
    return $key;
}

/**
 * Llama a la API de Messages y devuelve el JSON que cumple $schema (structured outputs).
 */
function claude_json(array $family, string $system, string $prompt, array $schema, string $effort = 'medium', int $maxTokens = 16000): array
{
    if (!function_exists('curl_init')) {
        fail('El servidor no tiene la extensión cURL de PHP activada.', 500);
    }
    $model = array_key_exists($family['ai_model'] ?? '', CLAUDE_MODELS) ? $family['ai_model'] : 'claude-opus-5-5';
    $body = [
        'model' => $model,
        'max_tokens' => $maxTokens,
        'system' => $system,
        'messages' => [['role' => 'user', 'content' => $prompt]],
        'output_config' => [
            'effort' => $effort,
            'format' => ['type' => 'json_schema', 'schema' => $schema],
        ],
    ];
    $headers = [
        'Content-Type: application/json',
        'x-api-key: ' . family_api_key($family),
        'anthropic-version: 2026-10-21',
    ];
    // Si Opus/Sonnet rechazan por precaución, la API reintenta sola con otro modelo.
    if ($model !== 'claude-haiku-5-5') {
        $body['fallbacks'] = 'default';
        $headers[] = 'anthropic-beta: server-side-fallback-2026-07-01';
    }

    $ch = curl_init('https://api.anthropic.com/v1/messages');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_UNICODE),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_TIMEOUT => 280,
    ]);
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        fail('No se pudo conectar con Claude: ' . $err, 502);
    }
    $res = json_decode((string)$raw, true);
    if ($status !== 200) {
        $msg = $res['error']['message'] ?? ('HTTP ' . $status);
        if ($status === 401) {
            $msg = 'La API key de Claude no es válida.';
        } elseif ($status === 429) {
            $msg = 'Claude está saturado o se alcanzó el límite de uso. Prueba en un minuto.';
        } elseif ($status === 400 && stripos($msg, 'credit') !== false) {
            $msg = 'La cuenta de Claude no tiene saldo suficiente.';
        }
        fail('Error de Claude: ' . $msg, 502);
    }
    $stop = $res['stop_reason'] ?? '';
    if ($stop === 'refusal') {
        fail('Claude no ha querido generar esta respuesta. Prueba a cambiar las indicaciones.', 502);
    }
    if ($stop === 'max_tokens') {
        fail('La respuesta de Claude se cortó por longitud. Inténtalo de nuevo.', 502);
    }
    $text = '';
    foreach ($res['content'] ?? [] as $block) {
        if (($block['type'] ?? '') === 'text') {
            $text .= $block['text'];
        }
    }
    $data = json_decode($text, true);
    if (!is_array($data)) {
        fail('Claude devolvió una respuesta que no se entiende. Inténtalo de nuevo.', 502);
    }
    return $data;
}

// ---------- Contexto de la familia para los prompts ----------

function family_members_with_prefs(int $familyId): array
{
    $members = q_all('SELECT id, name, notes FROM users WHERE family_id = ? ORDER BY id', [$familyId]);
    foreach ($members as &$m) {
        $m['like'] = $m['dislike'] = $m['allergy'] = [];
        foreach (q_all('SELECT kind, item FROM preferences WHERE user_id = ? ORDER BY item', [$m['id']]) as $p) {
            $m[$p['kind']][] = $p['item'];
        }
    }
    return $members;
}

function family_meals(array $family): array
{
    $meals = array_values(array_intersect(MEALS, explode(',', (string)$family['meals'])));
    return $meals ?: ['comida', 'cena'];
}

function family_servings(array $family, int $memberCount): int
{
    $s = (int)$family['servings'];
    return $s > 0 ? $s : max(1, $memberCount);
}

function family_context(array $family): string
{
    $members = family_members_with_prefs((int)$family['id']);
    $lines = ['Miembros de la familia:'];
    foreach ($members as $m) {
        $l = '- ' . $m['name'];
        if ($m['notes']) {
            $l .= ' (' . $m['notes'] . ')';
        }
        $l .= ': le gusta: ' . ($m['like'] ? implode(', ', $m['like']) : '—');
        $l .= '; NO le gusta: ' . ($m['dislike'] ? implode(', ', $m['dislike']) : '—');
        $l .= '; ALERGIAS/INTOLERANCIAS: ' . ($m['allergy'] ? implode(', ', $m['allergy']) : 'ninguna');
        $lines[] = $l;
    }
    $lines[] = '';
    $lines[] = 'Raciones por comida: ' . family_servings($family, count($members));
    $tips = trim((string)$family['tips']);
    if ($tips !== '') {
        $lines[] = '';
        $lines[] = 'Indicaciones permanentes de la familia:';
        foreach (preg_split('/\R/', $tips) as $t) {
            if (trim($t) !== '') {
                $lines[] = '- ' . trim($t);
            }
        }
    }
    return implode("\n", $lines);
}

const MENU_SYSTEM = 'Eres un planificador de menús familiares en España. Propones platos caseros, realistas, '
    . 'variados y equilibrados, con ingredientes fáciles de encontrar en un supermercado español (por ejemplo Dia). '
    . 'Las alergias e intolerancias son obligatorias: nunca incluyas un ingrediente al que alguien sea alérgico, '
    . 'ni trazas evidentes. Evita lo que no gusta a algún miembro y prioriza lo que gusta a varios. '
    . 'Escribe los nombres de los platos en español, cortos y claros.';

function ingredient_schema(): array
{
    return [
        'type' => 'array',
        'items' => [
            'type' => 'object',
            'properties' => [
                'name' => ['type' => 'string', 'description' => 'Ingrediente en singular y genérico, p.ej. "tomate", "pechuga de pollo"'],
                'quantity' => ['type' => 'string', 'description' => 'Cantidad total para las raciones indicadas, p.ej. "500 g", "2 ud", "1 l"'],
                'section' => ['type' => 'string', 'enum' => SECTIONS],
            ],
            'required' => ['name', 'quantity', 'section'],
            'additionalProperties' => false,
        ],
    ];
}

/** Genera la semana completa (solo platos; los ingredientes van aparte para no superar tiempos del hosting). */
function ai_generate_week(array $family, string $instructions, array $recentDishes): array
{
    $meals = family_meals($family);
    $prompt = family_context($family) . "\n\n";
    if ($recentDishes) {
        $prompt .= "Platos de las últimas semanas (evita repetirlos salvo que se pida):\n- " . implode("\n- ", $recentDishes) . "\n\n";
    }
    if (trim($instructions) !== '') {
        $prompt .= "Indicaciones para ESTA semana:\n" . trim($instructions) . "\n\n";
    }
    $prompt .= 'Planifica el menú de lunes (day 0) a domingo (day 6) con estas comidas cada día: ' . implode(', ', $meals) . '. '
        . 'Cumple las indicaciones de frecuencia (por ejemplo "pescado 2 veces" significa exactamente dos platos de pescado en la semana). '
        . 'En "notes" pon una nota muy breve (acompañamiento, o "aprovecha sobras del martes"), o deja cadena vacía.';

    $schema = [
        'type' => 'object',
        'properties' => [
            'days' => [
                'type' => 'array',
                'items' => [
                    'type' => 'object',
                    'properties' => [
                        'day' => ['type' => 'integer', 'description' => '0 = lunes ... 6 = domingo'],
                        'meals' => [
                            'type' => 'array',
                            'items' => [
                                'type' => 'object',
                                'properties' => [
                                    'meal' => ['type' => 'string', 'enum' => $meals],
                                    'dish' => ['type' => 'string'],
                                    'notes' => ['type' => 'string'],
                                ],
                                'required' => ['meal', 'dish', 'notes'],
                                'additionalProperties' => false,
                            ],
                        ],
                    ],
                    'required' => ['day', 'meals'],
                    'additionalProperties' => false,
                ],
            ],
        ],
        'required' => ['days'],
        'additionalProperties' => false,
    ];
    $data = claude_json($family, MENU_SYSTEM, $prompt, $schema, 'medium', 16000);
    return $data['days'] ?? [];
}

/** Calcula ingredientes para varios platos. $dishes = [['id'=>, 'dish'=>, 'notes'=>], ...] */
function ai_ingredients(array $family, array $dishes, int $servings): array
{
    $prompt = family_context($family) . "\n\n"
        . "Calcula la lista de ingredientes para comprar de cada plato, para {$servings} raciones. "
        . "No incluyas agua, sal ni aceite de oliva salvo cantidades grandes. Usa cantidades de compra realistas.\n\nPlatos:\n";
    foreach ($dishes as $d) {
        $prompt .= '- id ' . $d['id'] . ': ' . $d['dish'] . ($d['notes'] ? ' (' . $d['notes'] . ')' : '') . "\n";
    }
    $schema = [
        'type' => 'object',
        'properties' => [
            'dishes' => [
                'type' => 'array',
                'items' => [
                    'type' => 'object',
                    'properties' => [
                        'id' => ['type' => 'integer'],
                        'ingredients' => ingredient_schema(),
                    ],
                    'required' => ['id', 'ingredients'],
                    'additionalProperties' => false,
                ],
            ],
        ],
        'required' => ['dishes'],
        'additionalProperties' => false,
    ];
    $data = claude_json($family, MENU_SYSTEM, $prompt, $schema, 'low', 16000);
    $out = [];
    foreach ($data['dishes'] ?? [] as $d) {
        $out[(int)$d['id']] = $d['ingredients'] ?? [];
    }
    return $out;
}

/** Propone un plato nuevo para un hueco concreto, teniendo en cuenta el resto de la semana. */
function ai_regenerate_dish(array $family, array $weekItems, array $slot, string $hint, int $servings): array
{
    $prompt = family_context($family) . "\n\nMenú actual de la semana:\n";
    foreach ($weekItems as $it) {
        if ($it['id'] == $slot['id'] || $it['dish'] === '') {
            continue;
        }
        $prompt .= '- ' . DAY_NAMES[(int)$it['day']] . ' ' . $it['meal'] . ': ' . $it['dish'] . "\n";
    }
    $prompt .= "\nPropón un plato NUEVO para el " . DAY_NAMES[(int)$slot['day']] . ' (' . $slot['meal'] . ') '
        . 'que sustituya a "' . $slot['dish'] . '" y no repita lo que ya hay en la semana.';
    if (trim($hint) !== '') {
        $prompt .= "\nPetición concreta: " . trim($hint);
    }
    $prompt .= "\nIncluye los ingredientes a comprar para {$servings} raciones (sin agua ni sal). En notes, una nota muy breve o cadena vacía.";
    $schema = [
        'type' => 'object',
        'properties' => [
            'dish' => ['type' => 'string'],
            'notes' => ['type' => 'string'],
            'ingredients' => ingredient_schema(),
        ],
        'required' => ['dish', 'notes', 'ingredients'],
        'additionalProperties' => false,
    ];
    return claude_json($family, MENU_SYSTEM, $prompt, $schema, 'low', 8000);
}

function clean_ingredients($list): array
{
    $out = [];
    foreach ((array)$list as $i) {
        $name = str_clean($i['name'] ?? '', 120);
        if ($name === '') {
            continue;
        }
        $out[] = [
            'name' => $name,
            'quantity' => str_clean($i['quantity'] ?? '', 60),
            'section' => normalize_section((string)($i['section'] ?? 'Otros')),
        ];
    }
    return $out;
}
