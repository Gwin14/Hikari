# Hikari

Editor de fotos profissional para iOS e Android (React Native + Expo SDK 58). A edição é não destrutiva e roda na GPU, com revelação RAW nativa, máscaras com IA e exportação completa.

## Recursos

| Área | O que tem |
|---|---|
| **Navegação** | Duas fontes com a mesma interface: **Fotos** (fototeca do aparelho, com álbuns e acesso limitado) e **Pastas** (Arquivos/iCloud/SD/SAF, acesso persistente e subpastas). Mesma grade, filtros (editadas, RAW, RAW+JPEG, escolhidas, favoritas, rejeitadas, ★), ordenação e seleção múltipla. |
| **RAW** | iOS: `CIRAWFilter` (ProRAW, DNG, CR3, NEF, ARW, RAF…), com redução de ruído na decodificação, reforço de tom, correção de lente e headroom de realces. Android: LibRaw via JNI, com fallback para o JPEG embutido. |
| **RAW+JPEG** | Pares aparecem como um item só, com badge `RAW+J`. No editor dá para escolher qual dos dois revelar. No iOS são os recursos de um mesmo PHAsset; no Android e nas pastas, o pareamento é pelo nome do arquivo. |
| **Ajustes** | Perfis, exposição, contraste, realces, sombras, brancos e pretos, temperatura e matiz, vibração e saturação, curvas RGB/R/G/B, mixer HSL de 8 faixas, gradação de cores (3 vias + global), claridade, textura, remover névoa, nitidez (raio, detalhe, máscara), redução de ruído de luminância e de cor, distorção, aberração cromática, vinheta da lente, vinheta pós-corte, granulação, P&B com mixer e LUT 3D `.cube` com intensidade. |
| **Geometria** | Corte com proporções, endireitar com auto-escala, giro de 90°, espelhamento, perspectiva vertical/horizontal. |
| **Máscaras** | Selecionar objeto, pessoas, fundo (Vision / ML Kit) e céu, pincel (tamanho, dureza, fluxo, borracha), gradiente linear, gradiente radial, faixa de luminância e faixa de cor (conta-gotas). Cada máscara tem ajustes locais próprios, inversão, opacidade e sobreposição. |
| **Fluxo** | Desfazer/refazer, comparar segurando ou em divisão, histograma com indicadores e sobreposição de recorte, auto-ajuste (tom + balanço de branco), predefinições embutidas e do usuário (com intensidade e compartilhamento `.hikari`), copiar/colar seletivo, aplicação em lote, instantâneos, classificação/escolha/rótulos e EXIF. |
| **Exportação** | JPEG, HEIC, PNG, TIFF (8 e **16 bits reais**) e WebP. Qualidade; tamanho original, por lado maior/menor, megapixels ou %. sRGB, Display P3 ou Adobe RGB. Metadados (todos, sem localização, só direitos autorais, nenhum), autor e direitos autorais. Nitidez de saída, marca d'água, modelo de nome de arquivo, predefinições de exportação e lote. Destinos: Fotos (álbum "Hikari"), **edição reversível do original no app Fotos** (PHAdjustmentData), junto aos originais, outra pasta ou compartilhar. Pode levar junto o sidecar `.xmp` e o RAW. |
| **Interoperabilidade** | Nas pastas, um sidecar `.xmp` com a receita completa e mapeamento `crs:` para Lightroom/ACR. Sidecars do Lightroom também são lidos. |
| **Idiomas** | Português (Brasil) e inglês, seguindo o sistema ou escolhidos em Ajustes. |

## Como rodar

O app usa um módulo nativo próprio (`modules/hikari-native`), então **não roda no Expo Go**. Use um development build:

```bash
npm install
```

```bash
npx expo run:ios
```

```bash
npx expo run:android
```

Também dá para usar `npx eas-cli@latest build --profile development`. No Android, o build baixa o LibRaw 0.21.3 do GitHub na primeira compilação (CMake FetchContent).

## Verificação

```bash
npm test
```

```bash
npx tsc --noEmit
```

```bash
npx eslint .
```

```bash
node scripts/check-shaders.mjs
```

O projeto Jest `gpu` (`src/__tests__/pipeline.gpu.test.ts`) renderiza os shaders reais com CanvasKit, o mesmo compilador SkSL do react-native-skia, e confere valores de pixel conhecidos:

- receita padrão = identidade;
- +1 EV dobra a luz linear;
- máscaras aplicam o ajuste só onde devem;
- as duas passadas de 16 bits reconstroem o valor exibido.

## Arquitetura

```
src/app/                 rotas (expo-router): (tabs)/index · folders · settings, folder/[id], editor/[key], export, batch
src/core/recipe/         receita não destrutiva (schema, defaults, migração, ops, presets)
src/core/pipeline/       SkSL (develop → local × N → finish), uniforms, geometria, render, máscaras
src/core/sources/        PhotoItem unificado: fototeca, pastas, pareamento RAW+JPEG
src/core/export/         opções e exportador (decodificação na resolução necessária, 16 bits, marca d'água, destinos)
src/core/auto/           histograma, auto-tom, auto-WB, máscara de céu
src/core/xmp/            sidecars XMP (hikari + crs)
src/core/db/             catálogo SQLite (receitas, classificações, instantâneos, predefinições, pastas, LUTs)
src/state/               zustand (editor, biblioteca) + MMKV (preferências)
src/ui/                  design system, grade, editor (canvas, recorte, alças, curvas, roda de cor, painéis)
modules/hikari-native/   Swift (CIRAWFilter, ImageIO, Vision, PhotoKit, bookmarks) + Kotlin/C++ (LibRaw, ML Kit, HeifWriter, TIFF)
```

### Desempenho dos sliders

A receita fica espelhada num shared value do Reanimated (`liveRecipe`). Os sliders escrevem direto nele pela UI thread, e o canvas grava uma `SkPicture` com os shaders a cada quadro, sem passar pela thread JS. Ao soltar o slider, a mudança entra no histórico e é salva.

Desfoques caros, usados em claridade, névoa, textura, nitidez e redução de ruído, são calculados uma vez por foto em resolução reduzida.

### Cor

Toda a matemática roda em sRGB linear estendido, em float, com `toLinearSrgb`. Assim os valores RAW acima de 1.0 e as cores P3 sobrevivem.

Na exportação, o shader `finish` escreve os valores já codificados no espaço de destino, como dados:

- **8 bits:** uma passada;
- **16 bits:** duas passadas, uma com o byte alto e outra com o byte baixo.

Isso garante 16 bits e P3 de verdade, qualquer que seja o formato da superfície.

## Limitações conhecidas

- **Céu:** a máscara é heurística (cor, brilho, textura e conectividade a partir do topo). Um modelo de segmentação dedicado pode substituí-la sem mudar o restante.
- **WebP no iOS:** é codificado pelo Skia e não leva metadados, porque o ImageIO não grava WebP.
- **Edição reversível no Fotos:** é exclusiva do iOS. No Android, a exportação salva uma cópia.
- **TIFF no Android:** é gravado sem compressão e sem perfil ICC embutido.
- **LibRaw:** é usado sob a licença CDDL 1.0.
