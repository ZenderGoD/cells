package main

import (
	"html/template"
	"log"
	"net/http"
	"strconv"
)

type gameState struct {
	Board        [9]string
	Current      string
	Finished     bool
	Winner       string
	WinningCells map[int]bool
	XScore       int
	OScore       int
	DrawScore    int
}

type pageData struct {
	Cells  []cellData
	Status template.HTML
	Game   gameState
}

type cellData struct {
	Index    int
	Value    string
	Class    string
	Disabled bool
	Label    string
}

var state = gameState{
	Current:      "X",
	WinningCells: map[int]bool{},
}

var winningLines = [][3]int{
	{0, 1, 2},
	{3, 4, 5},
	{6, 7, 8},
	{0, 3, 6},
	{1, 4, 7},
	{2, 5, 8},
	{0, 4, 8},
	{2, 4, 6},
}

func main() {
	http.HandleFunc("/", handleIndex)
	http.HandleFunc("/move", handleMove)
	http.HandleFunc("/new-round", handleNewRound)
	http.HandleFunc("/reset-score", handleResetScore)

	log.Println("Tic Tac Toe running at http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if err := pageTemplate.Execute(w, buildPageData()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func handleMove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}

	index, err := strconv.Atoi(r.FormValue("cell"))
	if err == nil && index >= 0 && index < len(state.Board) {
		play(index)
	}

	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func handleNewRound(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		startRound()
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func handleResetScore(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		state.XScore = 0
		state.OScore = 0
		state.DrawScore = 0
		startRound()
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func play(index int) {
	if state.Finished || state.Board[index] != "" {
		return
	}

	state.Board[index] = state.Current
	winner, line := getWinner()

	switch {
	case winner != "":
		state.Finished = true
		state.Winner = winner
		state.WinningCells = map[int]bool{line[0]: true, line[1]: true, line[2]: true}
		if winner == "X" {
			state.XScore++
		} else {
			state.OScore++
		}
	case boardFull():
		state.Finished = true
		state.DrawScore++
	default:
		if state.Current == "X" {
			state.Current = "O"
		} else {
			state.Current = "X"
		}
	}
}

func startRound() {
	state.Board = [9]string{}
	state.Current = "X"
	state.Finished = false
	state.Winner = ""
	state.WinningCells = map[int]bool{}
}

func getWinner() (string, [3]int) {
	for _, line := range winningLines {
		a, b, c := line[0], line[1], line[2]
		if state.Board[a] != "" && state.Board[a] == state.Board[b] && state.Board[a] == state.Board[c] {
			return state.Board[a], line
		}
	}
	return "", [3]int{}
}

func boardFull() bool {
	for _, value := range state.Board {
		if value == "" {
			return false
		}
	}
	return true
}

func buildPageData() pageData {
	cells := make([]cellData, 0, len(state.Board))
	for index, value := range state.Board {
		class := "cell"
		if value == "X" {
			class += " x"
		}
		if value == "O" {
			class += " o"
		}
		if state.WinningCells[index] {
			class += " win"
		}

		label := "Cell " + strconv.Itoa(index+1) + ": empty"
		if value != "" {
			label = "Cell " + strconv.Itoa(index+1) + ": " + value
		}

		cells = append(cells, cellData{
			Index:    index,
			Value:    value,
			Class:    class,
			Disabled: state.Finished || value != "",
			Label:    label,
		})
	}

	return pageData{
		Cells:  cells,
		Status: statusText(),
		Game:   state,
	}
}

func statusText() template.HTML {
	if state.Winner != "" {
		return template.HTML("<strong>" + state.Winner + "</strong> wins the round.")
	}
	if state.Finished {
		return "It is a draw."
	}
	return template.HTML("<strong>" + state.Current + "</strong> is up.")
}

var pageTemplate = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tic Tac Toe</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7fb;
        --panel: #ffffff;
        --ink: #1c2331;
        --muted: #667085;
        --line: #d9e0ea;
        --x: #2563eb;
        --o: #e05d2f;
        --win: #14a06f;
        --shadow: 0 24px 70px rgba(28, 35, 49, 0.14);
      }

      * { box-sizing: border-box; }

      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        background:
          linear-gradient(135deg, rgba(37, 99, 235, 0.12), transparent 38%),
          linear-gradient(315deg, rgba(224, 93, 47, 0.13), transparent 42%),
          var(--bg);
        color: var(--ink);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      main {
        width: min(92vw, 520px);
        padding: 28px;
        border: 1px solid rgba(217, 224, 234, 0.86);
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.82);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 18px;
        margin-bottom: 22px;
      }

      h1 {
        margin: 0;
        font-size: clamp(2rem, 8vw, 3.8rem);
        line-height: 0.95;
        letter-spacing: 0;
      }

      .scoreboard {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        margin-bottom: 18px;
      }

      .score {
        min-width: 0;
        padding: 10px 8px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.76);
        text-align: center;
      }

      .score span {
        display: block;
        color: var(--muted);
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
      }

      .score strong {
        display: block;
        margin-top: 3px;
        font-size: 1.25rem;
      }

      .status {
        min-height: 30px;
        margin: 0 0 18px;
        color: var(--muted);
        font-size: 1rem;
        font-weight: 700;
      }

      .status strong { color: var(--ink); }

      .board {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        aspect-ratio: 1;
      }

      .cell-form { margin: 0; }

      .cell {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        border: 0;
        border-radius: 16px;
        background: var(--panel);
        color: var(--ink);
        box-shadow: inset 0 0 0 1px var(--line);
        font-size: clamp(3rem, 16vw, 5.75rem);
        font-weight: 900;
        line-height: 1;
        cursor: pointer;
        transition: transform 140ms ease, box-shadow 140ms ease, background 140ms ease;
      }

      .cell:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: inset 0 0 0 1px #b8c5d8, 0 12px 24px rgba(28, 35, 49, 0.12);
      }

      .cell:focus-visible {
        outline: 3px solid rgba(37, 99, 235, 0.32);
        outline-offset: 3px;
      }

      .cell:disabled { cursor: default; }
      .cell.x { color: var(--x); }
      .cell.o { color: var(--o); }

      .cell.win {
        background: rgba(20, 160, 111, 0.12);
        box-shadow: inset 0 0 0 2px rgba(20, 160, 111, 0.75);
      }

      .actions {
        display: flex;
        gap: 10px;
        margin-top: 18px;
      }

      .action-form { flex: 1; margin: 0; }

      button.action {
        width: 100%;
        min-height: 44px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #ffffff;
        color: var(--ink);
        font: inherit;
        font-weight: 800;
        cursor: pointer;
      }

      button.action.primary {
        border-color: #1c2331;
        background: #1c2331;
        color: #ffffff;
      }

      @media (max-width: 460px) {
        main {
          padding: 18px;
          border-radius: 18px;
        }

        header { display: block; }
        .actions { flex-direction: column; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Tic Tac Toe</h1>
      </header>

      <section class="scoreboard" aria-label="Scoreboard">
        <div class="score"><span>X wins</span><strong>{{.Game.XScore}}</strong></div>
        <div class="score"><span>Draws</span><strong>{{.Game.DrawScore}}</strong></div>
        <div class="score"><span>O wins</span><strong>{{.Game.OScore}}</strong></div>
      </section>

      <p class="status">{{.Status}}</p>

      <section class="board" aria-label="Tic tac toe board">
        {{range .Cells}}
          <form class="cell-form" action="/move" method="post">
            <input type="hidden" name="cell" value="{{.Index}}" />
            <button class="{{.Class}}" type="submit" aria-label="{{.Label}}" {{if .Disabled}}disabled{{end}}>{{.Value}}</button>
          </form>
        {{end}}
      </section>

      <div class="actions">
        <form class="action-form" action="/new-round" method="post">
          <button class="action primary" type="submit">New round</button>
        </form>
        <form class="action-form" action="/reset-score" method="post">
          <button class="action" type="submit">Reset score</button>
        </form>
      </div>
    </main>
  </body>
</html>`))
