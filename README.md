# opencode-usage-total 🧠

Realiza el seguimiento de modelos, tokens y costos por agente en la barra lateral de OpenCode.

![version](https://img.shields.io/badge/version-0.2.0-muted)

## Características

- Rastrea cada modelo usado por el agente principal y todos los sub-agentes
- Muestra el agente o sub-agente, el modelo y el costo
- Sección colapsable con `Alt+M`
- Acumula costo durante toda la sesión
- Los modelos de sub-agentes se atribuyen a la sesión padre
- Persistencia vía KV — sobrevive reinicios y cambios de sesión

> **⚠️ Nota sobre los tokens:** estamos trabajando para poder contar con exactitud los tokens de contexto de cada modelo. Por ahora la barra lateral solo muestra el **costo**, no la cantidad de tokens. El conteo de tokens se sigue recolectando internamente (en KV) para poder mostrarlo cuando esté listo, simplemente no se renderiza.

## Instalación

```bash
opencode plugin -g opencode-usage-total
```

## Actualización

```bash
rm -rf ~/.cache/opencode/packages/opencode-usage-total@latest
opencode plugin -g opencode-usage-total
```

## Uso

Abre una sesión en OpenCode. La barra lateral muestra una sección colapsable **🧠 Models** con cada modelo usado en la sesión actual.

Presiona `Alt+M` para colapsar o expandir la lista.

![sidebar](https://github.com/AlonsoSG0/opencode-usage-total/raw/main/image.png)

## Licencia

MIT
