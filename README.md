# Celular Indicator

Uma extensão do **GNOME Shell** que mostra a tela do celular **Android** no PC,
**sem cabo**, direto da barra superior — no espírito do *Vincular ao Celular*
(Phone Link) do Windows. Usa o [scrcpy](https://github.com/Genymobile/scrcpy) e o
`adb` por baixo e faz o pareamento por **QR code** ou por **código de 6 dígitos**.

## Instalação

```bash
git clone https://github.com/eltobsjr/celular-indicator.git
cd celular-indicator
./install.sh
gnome-extensions enable celular@eltobsjr.gmail.com
```

No **Wayland** é preciso fazer **logout/login** depois de instalar ou atualizar (o
`install.sh` não recarrega o Shell nem executa nada).

## Primeiro uso (parear uma vez)

1. No celular: **Configurações → Sobre o telefone → Informações do software**.
2. Toque **7 vezes** em **Número da versão** (ativa o modo de desenvolvedor).
3. **Opções do desenvolvedor → Depuração por Wi-Fi** → ligar.
4. No PC: menu do ícone → **Parear novo celular…** e escolha a aba:
   - **QR code**: no celular, toque em **Depuração por Wi-Fi → Parear o dispositivo com
     um QR code** e aponte a câmera para o QR do menu;
   - **Código** (sem câmera, ou se o QR não lê): no celular, **Parear o dispositivo com
     um código de pareamento**, digite os 6 números no menu e clique em **Parear com o
     código**. O PC acha o IP:porta sozinho pela rede; se não achar, use
     **Informar IP:porta manualmente** e copie o endereço que o celular mostra.
     Deixe a tela de código aberta no celular até terminar.

PC e celular precisam estar **no mesmo Wi-Fi**. Depois disso é só clicar em
**Abrir tela do celular**.

## O que tem no menu

- **Cartão do celular**: nome, marca/modelo, versão do Android, bateria, Wi-Fi
  (rede e sinal), IP, status Online/Offline/Conectado e "visto por último".
  Os dados ficam em `~/.local/share/celular/last-device.json` e são atualizados
  quando o celular conecta (e ao abrir o menu enquanto espelha, no máximo a cada 30 s).
- **Abrir tela do celular** (espelhamento com scrcpy) — vira **Cancelar**/**Fechar**.
- **Estado da conexão**: passos numerados (rede do PC → adb → procurar → conectar →
  abrir tela) e, se algo falhar, **o motivo em português + dica de correção**, com
  **Tentar novamente**, **Diagnosticar** e **Parear de novo**.
- **Controles** (via `adb`): Voltar, Início, Recentes, Tela (liga/desliga), Volume,
  Câmera, Captura de tela (salva em `~/Imagens/Celular`), mídia (anterior/tocar/
  próxima) e **Última foto** (copia a foto/print mais recente do celular).
- **Enviar arquivos para o celular…** (seletor do zenity → pasta Download).
- **Notificações do celular** (lidas sob demanda ao abrir o submenu) e, com
  **Tempo real** ligado, as novas aparecem como notificação do GNOME na hora.
- **Chamadas**: ligar para um número (ou abrir o discador preenchido), atender,
  desligar e histórico (se o Android deixar o adb ler). A conversa é pelo celular.
- **Mensagens (SMS)**: nova mensagem/responder abre o app de mensagens do celular já
  preenchido — você confirma o envio na tela do celular; lista das recebidas se o
  Android permitir (senão, elas chegam por Notificações).
- **Não perturbe no celular** (switch) e, opcionalmente, junto com o do GNOME.
- **Ponto de acesso do celular…** (abre os ajustes de hotspot no celular).
- **Abrir app do celular em janela** (`scrcpy --new-display --start-app`).
- **Diagnosticar conexão**, **Esquecer este celular**, **Opções** e **Configurações**.

Pelo terminal: `celular`, `celular --parear` (QR), `celular --codigo` (código de 6 dígitos), `celular --diagnostico`, `celular --info`.

## Por que não conecta? (códigos de erro)

O backend classifica o problema e a extensão mostra texto + dica. Os principais:

| Código | O que significa |
|---|---|
| `no_network` / `wifi_off` | PC sem rede / Wi-Fi do PC desligado |
| `different_network` | O último IP do celular não está em nenhuma sub-rede do PC (Wi-Fi diferente, 2,4 × 5 GHz, rede de visitante) |
| `vpn_interference` | VPN (Tailscale, WireGuard…) é a rota padrão do PC |
| `mdns_unavailable` | A descoberta mDNS do adb não funciona (firewall bloqueando 5353/UDP) |
| `wifi_debug_off` | O IP do celular responde, mas a porta do adb recusa — Depuração por Wi-Fi desligada |
| `phone_unreachable` | O celular não responde: tela bloqueada/economia de energia ou isolamento de clientes no roteador |
| `port_changed` | IP/porta mudou (reinício do celular ou da depuração) |
| `pairing_revoked` / `unauthorized` / `device_offline` | Pareamento revogado, falta tocar em «Permitir», ou adb vê o celular como offline |
| `pair_timeout` / `pair_failed` / `connect_failed` | Problemas no pareamento por QR |
| `pair_code_invalid` / `pair_code_timeout` / `pair_code_failed` | Código malformado, celular sem a tela de código aberta, ou código/IP:porta recusado |
| `adb_missing` / `scrcpy_missing` / `scrcpy_too_old` | Ferramentas ausentes ou antigas |
| `adb_server_failed` / `adb_version_conflict` | Porta 5037 presa ou dois adb de versões diferentes |
| `server_connection_failed` / `device_lost` / `connection_lost` / `encoder_error` / `video_output_error` / `audio_failed` | Erros do scrcpy traduzidos |
| `resource_memory` / `resource_cpu` | O watchdog encerrou o espelhamento para proteger o PC |
| `backend_unresponsive` / `too_many_failures` | O backend travou numa fase, ou falhou 3× seguidas em 60 s (pausa de 60 s) |

Log detalhado (sobrevive a um reset forçado, grava com `fsync`):
`~/.local/state/celular/backend.log`.

## Segurança contra travamentos

O espelhamento já travou a máquina inteira neste notebook híbrido (Intel + NVIDIA,
Wayland). As proteções agora são:

- **Nada pesado no gnome-shell**: todo adb/rede/scrcpy roda no backend; a extensão só
  lê linhas JSON assíncronas, com timeout por fase (sem notícia → mata e avisa).
- **scrcpy só na GPU integrada** (Mesa): o backend esconde o driver NVIDIA do scrcpy
  (`__EGL_VENDOR_LIBRARY_FILENAMES`, `__GLX_VENDOR_LIBRARY_NAME=mesa`,
  `VK_DRIVER_FILES`, `__NV_PRIME_RENDER_OFFLOAD=0`) e usa `--render-driver=opengl`.
  Há relatos de SDL3 + NVIDIA travando o sistema todo
  ([libsdl-org/SDL#14278](https://github.com/libsdl-org/SDL/issues/14278)).
  Se ainda assim der problema: Configurações → Renderizador → **Software**.
- **Padrões conservadores**: 1280 px, 60 FPS, 8 Mbps e **sem áudio** (opcional).
- **Escopo systemd** (`systemd-run --user --scope`): `MemoryMax` (limite + 256 MB),
  `MemorySwapMax=0` (estoura rápido em vez de afogar o zram), `CPUQuota=300%`,
  `TasksMax=256` e `nice 5`.
- **Watchdog no backend**: mata o scrcpy acima do limite de memória (padrão 1 GB) ou
  acima de 300 % de CPU por 16 s; registra memória livre e PSI a cada 10 s no log;
  sai sozinho se o gnome-shell morrer (logout) e o scrcpy morre junto com o backend
  (`PR_SET_PDEATHSIG`).
- **Anti-laço** e reconexão automática **opcional** com só 3 tentativas
  (15 s, 45 s, 2 min) ou quando a rede do PC muda — nunca polling.

## Windows Phone Link × Celular (GNOME)

| Recurso do Phone Link | Aqui | Observação |
|---|---|---|
| Cartão do telefone (nome, bateria, conectado) | ✅ igual | + modelo, Android, Wi-Fi/sinal, IP e "visto por último" |
| Tela do telefone (espelhamento com mouse/teclado) | ✅ igual | scrcpy; atalhos Alt/Super+H/B/S etc. |
| Apps em janela própria | ✅ parcial | `--new-display --start-app` (scrcpy ≥ 3, Android 10+); sem "recentes"/fixar na barra |
| Copiar/colar entre PC e celular | ✅ parcial | automático **enquanto a tela está aberta** (scrcpy); sem sincronizar com a tela fechada |
| Enviar arquivos | ✅ parcial | seletor → `adb push` para Download; sem arrastar-e-soltar |
| Fotos recentes | ✅ parcial | "Última foto" copia a mais recente; sem galeria |
| Notificações | ✅ parcial | lista sob demanda (título/texto) + tempo real opcional (abaixo); sem responder nem dispensar |
| Controle de mídia | ✅ parcial | anterior/tocar/próxima por keyevent; sem capa/título da música |
| Emparelhamento por QR com passos numerados | ✅ igual | QR de "Depuração por Wi-Fi" |
| Tela de erro/desconectado com "Tentar novamente" e dicas (mesmo Wi-Fi, AP isolation, VPN, economia de energia) | ✅ igual | com diagnóstico automático |
| Reconexão automática | ✅ parcial | opcional, por evento, poucas tentativas |
| Notificações em tempo real | ✅ parcial | opcional, **por evento** (`logcat -b events` bloqueado esperando `notification_enqueue`), sem polling; sem responder/dispensar |
| Bateria ao vivo | ✅ parcial | pelo evento `battery_level` enquanto o tempo real está ligado |
| Mensagens (SMS) | ✅ parcial | enviar = app de mensagens do celular preenchido (confirmação no celular); ler a caixa só se o Android der `READ_SMS` ao adb — na maioria dos aparelhos novos não dá, aí as novas chegam por Notificações |
| Chamadas | ✅ parcial | ligar/atender/desligar e histórico (se permitido); **áudio da chamada fica no celular** (o scrcpy não manda o microfone do PC) |
| Não perturbe sincronizado | ✅ parcial | `cmd notification set_dnd` (conferido em `zen_mode`); se o aparelho recusar, abre a tela de Não perturbe; sincroniza GNOME → celular, não o contrário |
| Ponto de acesso instantâneo | ✅ parcial | abre os ajustes de hotspot no celular; ligar sozinho exigiria privilégio de sistema |
| Responder notificação / arrastar arquivos / galeria completa | ❌ | exigiriam app companheiro no celular |

## Testes

```bash
make check   # sintaxe JS/Python e schema
make test    # backend com adb/scrcpy falsos (não toca no celular nem no adb real)
```

## Licença

MIT — veja [LICENSE](LICENSE).
