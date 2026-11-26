<?php
// Copia este archivo como config.php y rellena tus datos.
// config.php NO se sube a GitHub (está en .gitignore).
return [
    'db' => [
        'host' => 'localhost',
        'name' => 'menus',
        'user' => 'usuario_mysql',
        'pass' => 'contraseña_mysql',
        'port' => 3306,
    ],
    // Clave secreta para cifrar la API key de Claude. 64 caracteres hexadecimales.
    // install.php te genera una. Si la cambias, habrá que volver a guardar la API key.
    'app_key' => 'PON_AQUI_64_CARACTERES_HEX',
    // URL pública de la app, sin barra final (se usa en los enlaces de invitación)
    'base_url' => 'https://menus.teenidol.es',
    // true solo en local para ver errores
    'debug' => false,
];
