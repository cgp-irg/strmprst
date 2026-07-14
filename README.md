# Карта строек Москвы

Статическая карта строительных проектов Москвы (Leaflet, без сборки) по данным
[stroimprosto.mos.ru](https://stroimprosto.mos.ru/map/).

- **Живая карта:** https://cgp-irg.github.io/strmprst/ (ветка `gh-pages`)
- **Исходники сайта и пайплайна:** ветка `main`

## Как устроено

| Ветка | Что лежит |
|---|---|
| `main` | `index.html`, `app.js`, `app.css`, `vendor/`, скрипты в `tools/` |
| `gh-pages` | то же самое **плюс `data/`** — целиком перезаписывается одним коммитом при каждом обновлении, поэтому история репозитория не растёт |

GitHub Pages настроен на ветку `gh-pages`, корень.

## Автообновление (раз в неделю)

`tools/update_site.ps1` качает данные, собирает сайт в `build/site` и делает force-push
в `gh-pages`. Запускается Планировщиком задач Windows (задача `strmprst-weekly`,
понедельник, 04:00; пропущенный запуск догоняется при следующем включении ПК).

**Важно:** `stroimprosto.mos.ru` отвечает только российским IP — с раннеров GitHub Actions
сайт недоступен (проверено: Москва 200, Австрия/Швейцария/Нидерланды/Португалия — таймаут).
Поэтому сбор данных выполняется локально, а не в CI.

Токен GitHub (scope `repo` / Contents: write) лежит в `%USERPROFILE%\.strmprst\gh_token.txt`
и в репозиторий не попадает.

Ручной запуск:

```powershell
powershell -ExecutionPolicy Bypass -File tools\update_site.ps1            # обновить и опубликовать
powershell -ExecutionPolicy Bypass -File tools\update_site.ps1 -SkipPush  # только собрать в build\site
```

Логи: `logs\update-<дата>.log` (хранятся последние 12).

## Данные

`tools/update_data.py` (нужны `requests`, `shapely`) обращается к API карты
(`POST .../mapControl/ws/*`, form-encoded, обязательны заголовки `Origin`/`Referer`) и пишет:

| Файл | Содержимое |
|---|---|
| `data/projects_web.geojson` | полигоны проектов (упрощение ~0,4 м); если полигона нет — точка-фолбэк |
| `data/metadata.json` | счётчики, списки округов/районов/статусов, `generated_at` |
| `data/ps/<UIN>.json` | паспорт проекта: организации, ТЭП, документы, кадастр |
| `data/ps_index.json` | UIN с непустым паспортом |
| `data/org_index.json` | индекс организаций для фильтра по застройщику |

Страховка от порчи живой карты: если источник вернул меньше `--min-projects` (по умолчанию
5000) объектов, обновление прерывается и `gh-pages` остаётся прежней.
