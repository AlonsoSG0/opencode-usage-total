# opencode-usage-total 🧠

Seguí el uso de modelos, tokens y costos por agente en la barra lateral de OpenCode.

![version](https://img.shields.io/badge/version-0.1.0-muted)

## Características

- Rastrea cada modelo usado por el agente principal y todos los sub-agentes
- Muestra el agente o sub-agente, el modelo, los tokens y el costo
- Sección colapsable con `Alt+M`
- Acumula costo y tokens durante toda la sesión
- Los modelos de sub-agentes se atribuyen a la sesión padre
- Persistencia vía KV — sobrevive reinicios y cambios de sesión

## Instalación

```bash
opencode plugin install opencode-usage-total
```

O agregalo manualmente en `tui.json`:

```json
{
  "plugin": ["opencode-usage-total"]
}
```

## Uso

Abrí una sesión en OpenCode. La barra lateral muestra una sección colapsable **🧠 Models** con cada modelo usado en la sesión actual.

Presioná `Alt+M` para colapsar o expandir la lista.

![sidebar](https://github.com/AlonsoSG0/opencode-usage-total/raw/main/image.png)

## Licencia

MIT
