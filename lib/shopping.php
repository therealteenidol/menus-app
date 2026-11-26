<?php
// Construcción de la lista de la compra a partir de los ingredientes del menú.
declare(strict_types=1);

function lower(string $s): string
{
    return function_exists('mb_strtolower') ? mb_strtolower($s, 'UTF-8') : strtolower($s);
}

/** Convierte "500 g" / "1,5 kg" / "2 ud" a [cantidad, unidad base] o null si no se puede. */
function parse_qty(string $q): ?array
{
    $q = lower(trim($q));
    if (!preg_match('/^(\d+(?:[.,]\d+)?)\s*([a-záéíóúñ]*)\.?$/u', $q, $m)) {
        return null;
    }
    $n = (float)str_replace(',', '.', $m[1]);
    $u = $m[2];
    $map = [
        '' => ['ud', 1], 'u' => ['ud', 1], 'ud' => ['ud', 1], 'uds' => ['ud', 1], 'unidad' => ['ud', 1], 'unidades' => ['ud', 1],
        'g' => ['g', 1], 'gr' => ['g', 1], 'gramos' => ['g', 1], 'kg' => ['g', 1000], 'kilo' => ['g', 1000], 'kilos' => ['g', 1000],
        'ml' => ['ml', 1], 'cl' => ['ml', 10], 'l' => ['ml', 1000], 'litro' => ['ml', 1000], 'litros' => ['ml', 1000],
    ];
    if (!isset($map[$u])) {
        return [$n, $u]; // unidad desconocida (latas, dientes…): se suman si coincide
    }
    return [$n * $map[$u][1], $map[$u][0]];
}

function format_qty(float $n, string $unit): string
{
    $fmt = function (float $x): string {
        $s = rtrim(rtrim(number_format($x, 2, ',', ''), '0'), ',');
        return $s === '' ? '0' : $s;
    };
    if ($unit === 'g' && $n >= 1000) {
        return $fmt($n / 1000) . ' kg';
    }
    if ($unit === 'ml' && $n >= 1000) {
        return $fmt($n / 1000) . ' l';
    }
    return $fmt($n) . ($unit === '' ? '' : ' ' . $unit);
}

/** Junta ingredientes repetidos sumando cantidades cuando las unidades coinciden. */
function aggregate_ingredients(array $ingredients): array
{
    $groups = [];
    foreach ($ingredients as $i) {
        $key = lower(trim($i['name']));
        if (!isset($groups[$key])) {
            $groups[$key] = ['name' => $i['name'], 'section' => $i['section'], 'sums' => [], 'other' => []];
        }
        $q = trim((string)$i['quantity']);
        if ($q === '') {
            continue;
        }
        $p = parse_qty($q);
        if ($p) {
            $groups[$key]['sums'][$p[1]] = ($groups[$key]['sums'][$p[1]] ?? 0) + $p[0];
        } else {
            $groups[$key]['other'][] = $q;
        }
    }
    $out = [];
    foreach ($groups as $g) {
        $parts = [];
        foreach ($g['sums'] as $unit => $n) {
            $parts[] = format_qty($n, (string)$unit);
        }
        $parts = array_merge($parts, array_unique($g['other']));
        $out[] = ['name' => $g['name'], 'section' => $g['section'], 'quantity' => implode(' + ', $parts)];
    }
    return $out;
}
