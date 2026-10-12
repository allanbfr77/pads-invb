# Pads Igreja

O **PC** (ligado à mesa de som) toca os pads. O **celular** do tecladista controla.

## Começando

**Windows:** dê dois cliques em `start.bat` (precisa de [Node.js](https://nodejs.org) e do Chrome).
**macOS:** `start.command`.
**Manual:** `npm install`, `npm start`, abra `http://localhost:3000/player` no Chrome e clique em **Iniciar áudio**.

No PC, na tela do player, escolha a saída de áudio (placa ou mesa) em **Listar saídas** e confira com **Testar saída**. A escolha fica salva.
No celular (mesmo Wi-Fi), abra o endereço mostrado no terminal ou leia o **QR Code** da tela do player.

Os inicializadores abrem o Chrome com um perfil próprio (pasta `chrome-profile`) que permite tocar sem clicar em "Iniciar áudio".

## No celular

- **Tons:** 12 teclas, com **Maior / Menor** no topo (as teclas passam a mostrar `Cm`, `Dm`...). Toque no tom para iniciar; toque no tom ativo (ou em **Fade out**) para encerrar. A troca de tom faz crossfade. Abaixo ficam os dois pads (timbre e nível de cada um), os 4 presets e o volume.
- **Dois pads juntos:** o **Pad 1** sempre toca; o **Pad 2** pode ficar desligado ou tocar em camada (ex.: Strings + Etéreo), cada um com nível próprio.
- **Culto:** o repertório do dia (música + tom). Toque numa música para tocar o tom dela, ou use **Anterior** e **Próxima**. Dá para adicionar, editar, reordenar e **colar uma lista** (uma música por linha: `Nome - G` ou `Nome - Am` para tom menor). Ao tocar uma música, o modo maior/menor dela também é aplicado.
- **Ajustes:** fade de entrada e de saída de cada pad, brilho, reverb, afinação (±50 centésimos), edição dos presets (guardam os dois pads, níveis e fades) e informações da conexão.

Vários celulares podem controlar ao mesmo tempo, todos sincronizados. Tudo é salvo no PC (`data.json`) e volta igual ao reabrir.

## Atalho na tela inicial

- **iPhone (Safari):** Compartilhar → Adicionar à Tela de Início.
- **Android (Chrome):** menu ⋮ → Adicionar à tela inicial.

Em HTTP puro o Chrome do Android cria só um atalho com barra do navegador. Para virar app de verdade (tela cheia), use HTTPS:

1. Instale o [mkcert](https://github.com/FiloSottile/mkcert) no PC e rode `mkcert -install`
2. `mkcert -cert-file cert.pem -key-file key.pem IP-DO-PC localhost`
3. Coloque `cert.pem` e `key.pem` na pasta do app (o servidor passa a usar HTTPS sozinho)
4. Instale o certificado raiz do mkcert no celular (`mkcert -CAROOT` mostra a pasta)

Dica: fixe o IP do PC no roteador para o endereço do atalho não mudar.

## Segurança (importante se o Wi-Fi da igreja é compartilhado)

Defina um PIN em `config.json`:

```json
{ "pin": "1234" }
```

(ou use a variável `PADS_PIN`). Com PIN, o celular pede o código uma vez e lembra. Após 5 erros, o IP fica bloqueado por 1 minuto. O próprio PC (localhost) não precisa de PIN. Páginas de outros sites não conseguem controlar o app.

## Pads reais (samples)

Coloque pastas de áudio em `samples/` (uma pasta por conjunto, arquivos nomeados pela nota: `C.mp3`, `Db.wav`...). Elas aparecem na lista de timbres dos pads. Para tons menores, use `Cm.mp3`, `Dbm.mp3`... na mesma pasta: o botão **Menor** toca esses arquivos (se o conjunto não tiver arquivos do modo escolhido, usa os do outro). O app faz o loop com crossfade automático e completa notas que faltarem. **Use arquivos curtos (10 a 60 s):** o navegador carrega o arquivo inteiro na memória, e um MP3 de 1 hora ocupa mais de 1 GB. Detalhes em `samples/LEIA-ME.txt`.

Sem samples, o app usa 3 timbres sintetizados (Quente, Cordas, Etéreo). Se um sample falhar ao carregar, ele cai no timbre sintetizado em vez de ficar em silêncio.

## Integração com o app de projeção (API)

Todas as rotas aceitam `?pin=1234` (ou o cabeçalho `X-Pin`) quando há PIN, exceto no próprio PC.

| Rota | O que faz |
|---|---|
| `GET /api/key?k=G` | toca o tom (`C`, `C#`, `Bb`, `0`-`11`; `off` faz fade out). `Am` toca em menor; `&mode=min` também; número puro mantém o modo atual |
| `GET /api/mode?m=min` | troca maior/menor (`maj` ou `min`) |
| `GET /api/fadeout` | fade out |
| `GET /api/next`, `/api/prev` | próxima / anterior do repertório |
| `GET /api/goto?i=3` | vai para a música 3 do repertório |
| `GET /api/preset?n=2` | aplica o preset 2 |
| `GET /api/volume?v=60` | volume (0-100) |
| `GET /api/timbre?id=warm` | troca o timbre do pad 1 (`&layer=2` para o pad 2; `id=off` desliga o pad 2) |
| `GET /api/level?layer=2&v=50` | nível do pad (0-100) |
| `GET /api/reverb?v=60` | reverb (0-100) |
| `POST /api/setlist` | substitui o repertório: `[{"name":"Santo","key":"D"},{"name":"Oração","key":"Am"}]` |
| `GET /api/state` | estado completo |

Exemplo no app Electron de projeção, ao avançar de música:

```js
fetch('http://IP-DO-PC:3000/api/key?k=' + encodeURIComponent(musica.tom));
```

Ou envie o repertório do culto inteiro com `POST /api/setlist` e use `next` a cada música.

## Aplicativo de desktop (Electron)

Opcional, no lugar do Chrome:

```
npm install --save-dev electron
npm run app
```

Para gerar o instalador: `npm install --save-dev electron-builder` e `npm run dist`. No app instalado, os dados e a pasta de samples ficam na pasta do usuário (menu **Pads → Abrir pasta de samples**). O áudio inicia sozinho, e há opção de iniciar junto com o computador.

## Teste

`npm test` roda um teste automático do servidor (rotas, WebSocket, presets, repertório, API, samples e PIN).
