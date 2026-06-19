# Team Capacity Calculator

App de desktop (Windows) para planear a capacidade de equipa por PI/sprint — horas de foco, ausências, overhead/cerimónias, e estimativa de Story Points por iteração.

## Como obter a app

Vai a [Releases](../../releases) e descarrega o `.exe` mais recente (ex: `Team Capacity Calculator x.y.z.exe`). Não precisas de instalar nada — é portátil, basta correr o ficheiro.

> **Nota:** o `.exe` não está assinado digitalmente. O Windows vai mostrar um aviso "Windows protected your PC" / SmartScreen no primeiro arranque. Clica em **"Mais informações"** → **"Executar mesmo assim"**. Isto só acontece uma vez por máquina.

No primeiro arranque, a app mostra um banner **"Connect a data file"** — os passos seguintes dependem de quem és.

---

## 👤 Sou de outra equipa, vou começar do zero

Se ainda não tens dados nenhuns e vais usar esta app para a tua própria equipa:

1. No banner inicial, escolhe **"Create new file"**.
2. Escolhe um local no teu computador (ou na pasta de rede da tua equipa) para guardar o ficheiro de dados — este vai ser o teu ficheiro principal.
3. A app começa vazia. Vais querer configurar: a tua equipa (Section 1 → Team), as cerimónias/overhead, as PIs e iterações da tua equipa, etc.
4. Opcionalmente, no botão **"🗄 Backup"** no topo, podes configurar um espelho de segurança (ex: uma pasta de rede da tua própria equipa) — isto é totalmente independente do resto.

⚠️ **Importante:** não escolhas "Open existing file" apontando para um ficheiro de outra equipa (ex: o backup da equipa SysMgm) — isso carregaria os dados *deles*, não os teus. Começa sempre com **"Create new file"**.

---

## 👤 Sou da equipa SysMgm e quero os dados atuais da equipa

Se te vais juntar à equipa SysMgm e queres continuar a partir dos dados que já existem (PIs, equipa, histórico):

1. Contacta o admin do projeto (**pij4ovr**) a pedir a localização do ficheiro de backup partilhado da equipa.
2. Copia esse ficheiro para uma pasta local no teu computador.
3. Abre a app → no banner inicial, escolhe **"Open existing file"** → seleciona a cópia local que acabaste de fazer. Isto vai ser o teu ficheiro principal (local).
4. Clica em **"🗄 Backup"** no topo e aponta para a **mesma** localização de rede que o admin te indicou. A partir daqui, a app mantém-se sincronizada automaticamente com o resto da equipa através desse ficheiro partilhado (sem precisares de copiar nada manualmente outra vez).

---

## Mais informação

- Arquitetura e detalhes técnicos: [ARCHITECTURE.md](ARCHITECTURE.md) e [CONTEXT.md](CONTEXT.md).
- Para correr a partir do código-fonte (desenvolvimento), ver `CONTEXT.md` secção "Desktop App Files & Build".
