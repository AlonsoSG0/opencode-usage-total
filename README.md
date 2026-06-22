# opencode-usage-total 🧠

Realiza el seguimiento de modelos, tokens y costos por agente en la barra lateral de OpenCode.

![version](https://img.shields.io/badge/version-0.1.13-muted)

## Características

- Rastrea cada modelo usado por el agente principal y todos los sub-agentes
- Muestra el agente o sub-agente, el modelo, los tokens y el costo
- Sección colapsable con `Alt+M`
- Acumula costo y tokens durante toda la sesión
- Los modelos de sub-agentes se atribuyen a la sesión padre
- Persistencia vía KV — sobrevive reinicios y cambios de sesión

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
