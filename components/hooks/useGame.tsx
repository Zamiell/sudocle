"use client"

import {
  ACTION_ALL,
  ACTION_CLEAR,
  ACTION_DOWN,
  ACTION_LEFT,
  ACTION_PUSH,
  ACTION_REMOVE,
  ACTION_RIGHT,
  ACTION_ROTATE,
  ACTION_SET,
  ACTION_UP,
  Action,
  ColoursAction,
  DigitsAction,
  FillCenterMarksAction,
  ModeAction,
  ModeGroupAction,
  PenLinesAction,
  SelectionAction,
  TYPE_CHECK,
  TYPE_COLOURS,
  TYPE_DIGITS,
  TYPE_FILL_CENTER_MARKS,
  TYPE_INIT,
  TYPE_MODE,
  TYPE_MODE_GROUP,
  TYPE_PAUSE,
  TYPE_PENLINES,
  TYPE_REDO,
  TYPE_SELECTION,
  TYPE_UNDO,
} from "../lib/Actions"
import {
  MODE_CENTRE,
  MODE_COLOUR,
  MODE_CORNER,
  MODE_NORMAL,
  MODE_PEN,
  Mode,
  getModeGroup,
} from "../lib/Modes"
import parseSolution from "../lib/parsesolution"
import { hasFog, ktoxy, xytok } from "../lib/utils"
import { Data, DataCell, FogLight } from "../types/Data"
import { Digit } from "../types/Game"
import { isEqual, isString } from "lodash"
import { create } from "zustand"
import { immer } from "zustand/middleware/immer"

const EmptyData: Data = {
  cellSize: 50,
  cells: [],
  regions: [],
  cages: [],
  lines: [],
  arrows: [],
  underlays: [],
  overlays: [],
  solved: false,
}

interface Colour {
  colour: number
}

export interface WrongSolutionErrors {
  type: "wrongsolution" // the solution is complete but wrong (errors will be revealed)
  errors: Set<number>
}

export interface OtherErrors {
  type:
    | "unknown" // the puzzle has not been checked for errors yet
    | "notstarted" // the solver has not started solving the puzzle
    | "goodsofar" // some but not all digits have been entered and they are correct
    | "badsofar" // the solution is incomplete and wrong (errors won't be revealed)
    | "solved" // the solution is correct
}

export type Errors = WrongSolutionErrors | OtherErrors
export type ErrorType = Errors["type"]

interface PersistentGameState {
  digits: Map<number, Digit>
  cornerMarks: Map<number, Set<number | string>>
  centreMarks: Map<number, Set<number | string>>
  colours: Map<number, Colour>
  penLines: Set<number>
  fogLights?: FogLight[]
  fogRaster?: number[][]
}

export interface GameState extends PersistentGameState {
  readonly data: Data
  mode: Mode
  modeGroup: number
  enabledModes0: Mode[]
  enabledModes1: Mode[]
  selection: Set<number>
  errors: Errors
  undoStates: PersistentGameState[]
  nextUndoState: number
  solved: boolean
  paused: boolean
  checkCounter: number
}

interface GameStateWithActions extends GameState {
  updateGame(action: Action): void
}

function makeGiven<T, R>(
  data: Data | undefined,
  accessor: (cell: DataCell) => T | undefined,
  generator: (value: T) => R,
): Map<number, R> {
  if (data === undefined || data.cells === undefined) {
    return new Map<number, R>()
  }

  let r = new Map<number, R>()
  data.cells.forEach((row, y) => {
    row.forEach((col, x) => {
      let v = accessor(col)
      if (v !== undefined && (!Array.isArray(v) || v.length > 0)) {
        r.set(xytok(x, y), generator(v))
      }
    })
  })
  return r
}

function makeGivenDigits(data: Data | undefined): Map<number, Digit> {
  return makeGiven(
    data,
    c => c.value,
    n => {
      if (isString(n)) {
        n = /^\d+$/.test(n) ? +n : n
      }
      return {
        digit: n,
        given: true,
        discovered: false,
      }
    },
  )
}

function makeGivenMarks<T extends (string | number)[]>(
  data: Data | undefined,
  accessor: (cell: DataCell) => T | undefined,
): Map<number, Set<string | number>> {
  return makeGiven(data, accessor, cms => {
    let digits = new Set<string | number>()
    for (let cm of cms) {
      let n = isString(cm) && /^\d+$/.test(cm) ? +cm : cm
      digits.add(n)
    }
    return digits
  })
}

/**
 * Calculate all current fog lights: use the static lights from the given data
 * object and add dynamic lights for correct digits.
 */
function makeFogLights(
  data: Data,
  digits: Map<number, Digit>,
): FogLight[] | undefined {
  if (data.fogLights === undefined) {
    // puzzle is not a fog puzzle
    return undefined
  }

  let r: FogLight[] = [...data.fogLights]
  if (data.solution !== undefined) {
    digits.forEach((v, k) => {
      let [x, y] = ktoxy(k)
      let expected = data.solution![y][x]
      if (!v.given && v.digit === expected) {
        r.push({
          center: [y, x],
          size: 3,
        })
      } else if (v.given && v.discovered) {
        r.push({
          center: [y, x],
          size: 1,
        })
      }
    })
  }
  return r
}

function makeFogRaster(
  data: Data,
  fogLights?: FogLight[],
): number[][] | undefined {
  if (fogLights === undefined) {
    return undefined
  }

  let cells: number[][] = Array(data.cells.length)
  for (let i = 0; i < data.cells.length; ++i) {
    cells[i] = Array(data.cells[0].length).fill(1)
  }

  for (let light of fogLights) {
    let y = light.center[0]
    let x = light.center[1]
    if (x < 0 || y < 0) {
      continue
    }
    if (light.size === 3) {
      if (y > 0) {
        if (x > 0) {
          cells[y - 1][x - 1] = 0
        }
        cells[y - 1][x] = 0
        if (x < cells[y - 1].length - 1) {
          cells[y - 1][x + 1] = 0
        }
      }
      cells[y][x - 1] = 0
      cells[y][x] = 0
      cells[y][x + 1] = 0
      if (y < cells.length - 1) {
        if (x > 0) {
          cells[y + 1][x - 1] = 0
        }
        cells[y + 1][x] = 0
        if (x < cells[y + 1].length - 1) {
          cells[y + 1][x + 1] = 0
        }
      }
    } else if (light.size === 1) {
      cells[y][x] = 0
    }
  }

  return cells
}

function parseFogLights(str: string): FogLight[] {
  let result: FogLight[] = []
  if (str === "") {
    return result
  }
  let matches = str.matchAll(/r(-?[0-9]+)c(-?[0-9]+)/gi)
  for (let m of matches) {
    let r = +m[1] - 1
    let c = +m[2] - 1
    if (r >= 0 && c >= 0) {
      result.push({
        center: [r, c],
        size: 1,
      })
    }
  }
  return result
}

function makeEmptyState(data?: Data): GameState {
  let digits = makeGivenDigits(data)
  let fogLights = makeFogLights(data ?? EmptyData, digits)

  return {
    data: data ?? EmptyData,
    mode: MODE_NORMAL,
    modeGroup: 0,
    enabledModes0: [MODE_NORMAL],
    enabledModes1: [MODE_PEN],
    digits,
    cornerMarks: makeGivenMarks(data, c => c.cornermarks),
    centreMarks: makeGivenMarks(data, c => c.centremarks),
    colours: new Map(),
    penLines: new Set(),
    selection: new Set(),
    errors: { type: "unknown" },
    undoStates: [],
    nextUndoState: 0,
    solved: data?.solved ?? false,
    paused: false,
    checkCounter: 0,
    fogLights,
    fogRaster: makeFogRaster(data ?? EmptyData, fogLights),
  }
}

function filterGivens(
  digits: Map<number, Digit>,
  selection: Set<number>,
): Set<number> {
  let r = new Set<number>()
  for (let sc of selection) {
    let cell = digits.get(sc)
    if (cell === undefined || !cell.given || cell.discovered) {
      r.add(sc)
    }
  }
  return r
}

function modeReducer(draft: GameState, action: ModeAction) {
  let newEnabledModes
  if (draft.modeGroup === 0) {
    newEnabledModes = [...draft.enabledModes0]
  } else {
    newEnabledModes = [...draft.enabledModes1]
  }

  switch (action.action) {
    case ACTION_SET:
      if (action.mode !== undefined) {
        newEnabledModes = [action.mode]
        draft.modeGroup = getModeGroup(action.mode)
      }
      break

    case ACTION_PUSH:
      if (action.mode !== undefined) {
        if (!newEnabledModes.includes(action.mode)) {
          newEnabledModes.push(action.mode)
        }
      }
      break

    case ACTION_REMOVE: {
      if (action.mode !== undefined) {
        let i = newEnabledModes.indexOf(action.mode)
        // Never remove the mode at position 0! It represents the previous one
        if (i >= 1) {
          newEnabledModes.splice(i, 1)
        }
      }
      break
    }
  }

  let newMode: Mode
  if (draft.modeGroup === 0) {
    newMode = MODE_NORMAL
  } else {
    newMode = MODE_PEN
  }
  if (newEnabledModes.length > 0) {
    newMode = newEnabledModes[newEnabledModes.length - 1]
  }

  if (action.action === ACTION_ROTATE) {
    switch (newMode) {
      case MODE_NORMAL:
        newMode = MODE_CORNER
        break
      case MODE_CORNER:
        newMode = MODE_CENTRE
        break
      case MODE_CENTRE:
        newMode = MODE_COLOUR
        break
      case MODE_COLOUR:
        newMode = MODE_NORMAL
        break
      case MODE_PEN:
        newMode = MODE_PEN
        break
    }
    newEnabledModes = [newMode]
  }

  draft.mode = newMode
  if (draft.modeGroup === 0) {
    draft.enabledModes0 = newEnabledModes
  } else {
    draft.enabledModes1 = newEnabledModes
  }
}

function modeGroupReducer(draft: GameState, action: ModeGroupAction) {
  switch (action.action) {
    case ACTION_ROTATE:
      draft.modeGroup = (draft.modeGroup + 1) % 2
      if (draft.modeGroup === 0) {
        draft.mode = draft.enabledModes0[draft.enabledModes0.length - 1]
      } else {
        draft.mode = draft.enabledModes1[draft.enabledModes1.length - 1]
      }
      break
  }
}

function marksReducer(
  marks: Map<number, Set<string | number>>,
  action: DigitsAction,
  selection: Set<number>,
  isCornerMarks = false,
  state?: GameState
) {
  let changed = false;
  
  switch (action.action) {
    case ACTION_SET: {
      if (action.digit !== undefined) {
        for (let sc of selection) {
          let digits = marks.get(sc)
          if (digits === undefined) {
            digits = new Set()
            marks.set(sc, digits)
          }
          if (digits.has(action.digit)) {
            digits.delete(action.digit)
          } else {
            digits.add(action.digit)
            changed = true;
          }
          if (digits.size === 0) {
            marks.delete(sc)
          }
        }
      }
      break
    }

    case ACTION_REMOVE: {
      for (let sc of selection) {
        if (marks.has(sc)) {
          changed = true;
          marks.delete(sc)
        }
      }
      break
    }
  }
  
  // If this is for corner marks and we have state, check for naked pairs
  if (isCornerMarks && changed && state) {
    // This function handles finding and checking naked pairs in corner marks
    const convertCornerMarkNakedPairs = (state: GameState) => {
      console.log(`Checking for corner mark naked pairs after update`);
      
      // Helper function to identify naked pairs 
      const findNakedPairs = (regionCells: number[], marksMap: Map<number, Set<number | string>>) => {
        // Map to track cells by their exact marks content
        const cellsByMarks = new Map<string, number[]>()
        
        // Find all cells with exactly 2 marks
        for (const cellK of regionCells) {
          // Skip cells with digits
          if (state.digits.get(cellK)) continue
          
          const marks = marksMap.get(cellK)
          if (marks && marks.size === 2) {
            // Create a key from the sorted marks
            const marksArray = Array.from(marks).map(m => m.toString()).sort()
            const marksKey = marksArray.join(',')
            
            // Add cell to the appropriate group
            if (!cellsByMarks.has(marksKey)) {
              cellsByMarks.set(marksKey, [])
            }
            cellsByMarks.get(marksKey)!.push(cellK)
          }
        }
        
        // Find pairs (exactly 2 cells with the same marks)
        const nakedPairs: { cells: number[], digits: (string | number)[] }[] = []
        
        cellsByMarks.forEach((cells, marksKey) => {
          if (cells.length === 2) {
            const marks = marksKey.split(',').map(d => {
              // Handle both string and number conversions
              return isNaN(Number(d)) ? d : Number(d)
            })
            nakedPairs.push({ cells, digits: marks })
          }
        })
        
        return nakedPairs
      }
      
      // Helper function to convert corner mark naked pairs to center marks
      const convertPairToCenter = (pair: { cells: number[], digits: (string | number)[] }) => {
        console.log(`Converting naked pair with digits [${pair.digits.join(',')}]`);
        
        // For each cell in the pair
        pair.cells.forEach(cellK => {
          // Get corner marks (should exist and have exactly 2 digits)
          const cornerMarks = state.cornerMarks.get(cellK)
          if (!cornerMarks || cornerMarks.size !== 2) return
          
          // Create center marks for the same digits if they don't exist
          let centerMarks = state.centreMarks.get(cellK)
          if (!centerMarks) {
            centerMarks = new Set<string | number>()
            state.centreMarks.set(cellK, centerMarks)
          }
          
          // Transfer all digits from corner marks to center marks
          cornerMarks.forEach(digit => {
            centerMarks!.add(digit)
          })
          
          // Remove the corner marks
          state.cornerMarks.delete(cellK)
        })
      }
      
      // Process all rows, columns and boxes
      
      // Process rows
      for (let row = 0; row < 9; row++) {
        const rowCells = Array.from({ length: 9 }, (_, col) => xytok(col, row))
        const nakedPairs = findNakedPairs(rowCells, state.cornerMarks)
        nakedPairs.forEach(convertPairToCenter)
      }
      
      // Process columns
      for (let col = 0; col < 9; col++) {
        const colCells = Array.from({ length: 9 }, (_, row) => xytok(col, row))
        const nakedPairs = findNakedPairs(colCells, state.cornerMarks)
        nakedPairs.forEach(convertPairToCenter)
      }
      
      // Process boxes
      for (let boxRow = 0; boxRow < 3; boxRow++) {
        for (let boxCol = 0; boxCol < 3; boxCol++) {
          const boxCells: number[] = []
          for (let row = boxRow * 3; row < boxRow * 3 + 3; row++) {
            for (let col = boxCol * 3; col < boxCol * 3 + 3; col++) {
              boxCells.push(xytok(col, row))
            }
          }
          
          const nakedPairs = findNakedPairs(boxCells, state.cornerMarks)
          nakedPairs.forEach(convertPairToCenter)
        }
      }
    }
    
    // Run the conversion
    convertCornerMarkNakedPairs(state);
  }
  
  return changed;
}

function digitsReducer(
  digits: Map<number, Digit>,
  action: DigitsAction,
  selection: Set<number>,
  cornerMarks?: Map<number, Set<string | number>>,
  centreMarks?: Map<number, Set<string | number>>,
): boolean {
  let changed = false

  switch (action.action) {
    case ACTION_SET: {
      if (action.digit !== undefined) {
        for (let sc of selection) {
          let oldDigit = digits.get(sc)
          if (oldDigit !== undefined && oldDigit.given) {
            if (oldDigit.digit === action.digit) {
              digits.set(sc, {
                digit: action.digit,
                given: true,
                discovered: true,
              })
              changed = true
            }
          } else {
            digits.set(sc, {
              digit: action.digit,
              given: false,
              discovered: false,
            })
            changed = true

            // After placing a digit, automatically remove invalid corner and center marks
            if (cornerMarks && centreMarks) {
              const [x, y] = ktoxy(sc)

              // Function to clear a specific mark from cells in the same row, column, or box
              const clearMarkInRelatedCells = (
                marksMap: Map<number, Set<string | number>>,
                digitToRemove: number | string,
              ) => {
                // Clear from same row
                for (let col = 0; col < 9; col++) {
                  if (col !== x) {
                    const k = xytok(col, y)
                    const marks = marksMap.get(k)
                    if (marks && marks.has(digitToRemove)) {
                      marks.delete(digitToRemove)
                      if (marks.size === 0) marksMap.delete(k)
                      console.log(
                        `Removed mark ${digitToRemove} from cell [${col}, ${y}] (same row)`,
                      )
                    }
                  }
                }

                // Clear from same column
                for (let row = 0; row < 9; row++) {
                  if (row !== y) {
                    const k = xytok(x, row)
                    const marks = marksMap.get(k)
                    if (marks && marks.has(digitToRemove)) {
                      marks.delete(digitToRemove)
                      if (marks.size === 0) marksMap.delete(k)
                      console.log(
                        `Removed mark ${digitToRemove} from cell [${x}, ${row}] (same column)`,
                      )
                    }
                  }
                }

                // Clear from same 3x3 box
                const boxStartX = Math.floor(x / 3) * 3
                const boxStartY = Math.floor(y / 3) * 3
                for (let row = boxStartY; row < boxStartY + 3; row++) {
                  for (let col = boxStartX; col < boxStartX + 3; col++) {
                    if (row !== y || col !== x) {
                      const k = xytok(col, row)
                      const marks = marksMap.get(k)
                      if (marks && marks.has(digitToRemove)) {
                        marks.delete(digitToRemove)
                        if (marks.size === 0) marksMap.delete(k)
                        console.log(
                          `Removed mark ${digitToRemove} from cell [${col}, ${row}] (same box)`,
                        )
                      }
                    }
                  }
                }
              }

              // Clear the placed digit from corner marks and center marks
              clearMarkInRelatedCells(cornerMarks, action.digit)
              clearMarkInRelatedCells(centreMarks, action.digit)
            }
          }
        }
      }
      break
    }

    case ACTION_REMOVE: {
      for (let sc of selection) {
        let oldDigit = digits.get(sc)
        if (oldDigit !== undefined && oldDigit.given) {
          digits.set(sc, {
            digit: oldDigit.digit,
            given: true,
            discovered: false,
          })
          changed = true
        } else {
          if (digits.delete(sc)) {
            changed = true
          }
        }
      }
      break
    }
  }

  return changed
}

function coloursReducer(
  colours: Map<number, Colour>,
  action: ColoursAction,
  selection: Iterable<number>,
) {
  switch (action.action) {
    case ACTION_SET: {
      if (action.digit !== undefined) {
        for (let sc of selection) {
          colours.set(sc, {
            colour: action.digit,
          })
        }
      }
      break
    }

    case ACTION_REMOVE: {
      for (let sc of selection) {
        colours.delete(sc)
      }
      break
    }
  }
}

function penLinesReducer(penLines: Set<number>, action: PenLinesAction) {
  switch (action.action) {
    case ACTION_PUSH: {
      if (Array.isArray(action.k)) {
        for (let k of action.k) {
          penLines.add(k)
        }
      } else {
        penLines.add(action.k)
      }
      return
    }

    case ACTION_REMOVE: {
      if (Array.isArray(action.k)) {
        for (let k of action.k) {
          penLines.delete(k)
        }
      } else {
        penLines.delete(action.k)
      }
      return
    }
  }
}

function selectionReducer(
  selection: Set<number>,
  action: SelectionAction,
  cells: DataCell[][] = [],
) {
  switch (action.action) {
    case ACTION_ALL:
      selection.clear()
      cells.forEach((row, y) => {
        row.forEach((col, x) => {
          selection.add(xytok(x, y))
        })
      })
      return
    case ACTION_CLEAR:
      selection.clear()
      return
    case ACTION_SET: {
      selection.clear()
      if (action.k !== undefined) {
        if (Array.isArray(action.k)) {
          for (let k of action.k) {
            selection.add(k)
          }
        } else {
          selection.add(action.k)
        }
      }
      return
    }
    case ACTION_PUSH: {
      if (action.k !== undefined) {
        if (Array.isArray(action.k)) {
          for (let k of action.k) {
            selection.add(k)
          }
        } else {
          selection.add(action.k)
        }
      }
      return
    }
    case ACTION_REMOVE: {
      if (action.k !== undefined) {
        if (Array.isArray(action.k)) {
          for (let k of action.k) {
            selection.delete(k)
          }
        } else {
          selection.delete(action.k)
        }
      }
      return
    }
  }

  if (
    selection.size > 0 &&
    (action.action === ACTION_RIGHT ||
      action.action === ACTION_LEFT ||
      action.action === ACTION_UP ||
      action.action === ACTION_DOWN)
  ) {
    let last = [...selection].pop()!
    if (!action.append) {
      selection.clear()
    }

    let [lastX, lastY] = ktoxy(last)
    let rowLength = cells[lastY]?.length || 1
    let colLength = cells.length

    let newK
    switch (action.action) {
      case ACTION_RIGHT:
        newK = xytok((lastX + 1) % rowLength, lastY)
        break
      case ACTION_LEFT:
        newK = xytok((lastX - 1 + rowLength) % rowLength, lastY)
        break
      case ACTION_UP:
        newK = xytok(lastX, (lastY - 1 + colLength) % colLength)
        break
      case ACTION_DOWN:
        newK = xytok(lastX, (lastY + 1) % colLength)
        break
    }

    if (newK !== undefined) {
      // re-add key so element becomes last in set
      selection.delete(newK)
      selection.add(newK)
    }
  }
}

function checkDuplicates(
  grid: (string | number)[][],
  errors: Set<number>,
  flip = false,
) {
  for (let y = 0; y < grid.length; ++y) {
    let cells = grid[y]
    if (cells !== undefined) {
      for (let x = 0; x < cells.length; ++x) {
        for (let x2 = x + 1; x2 < cells.length; ++x2) {
          if (
            cells[x] !== undefined &&
            cells[x2] !== undefined &&
            cells[x] === cells[x2]
          ) {
            if (flip) {
              errors.add(xytok(y, x))
              errors.add(xytok(y, x2))
            } else {
              errors.add(xytok(x, y))
              errors.add(xytok(x2, y))
            }
          }
        }
      }
    }
  }
}

function checkReducer(
  digits: Map<number, Digit>,
  cells: DataCell[][] = [],
  solution?: (number | undefined)[][],
): Errors {
  let errors = new Set<number>()

  if (solution === undefined) {
    // there is no solution
    let gridByRow: (string | number)[][] = []
    let gridByCol: (string | number)[][] = []

    let expectedDigits = cells.length * cells[0].length

    // check for empty cells
    let missingDigits = 0
    cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let k = xytok(x, y)
        let d = digits.get(k)
        if (d === undefined) {
          errors.add(k)
          ++missingDigits
        } else {
          if (d.given) {
            --expectedDigits
          }
          gridByRow[y] = gridByRow[y] || []
          gridByRow[y][x] = d.digit
          gridByCol[x] = gridByCol[x] || []
          gridByCol[x][y] = d.digit
        }
      })
    })

    // check for duplicate digits in rows
    checkDuplicates(gridByRow, errors)

    // check for duplicate digits in cols
    checkDuplicates(gridByCol, errors, true)

    if (errors.size === 0) {
      return { type: "solved" }
    } else if (missingDigits === 0) {
      return { type: "wrongsolution", errors }
    } else if (missingDigits === expectedDigits) {
      return { type: "notstarted" }
    } else if (missingDigits === errors.size) {
      return { type: "goodsofar" }
    }
    return { type: "badsofar" }
  }

  // check against solution
  let missingDigits = 0
  let matchingDigits = 0
  cells.forEach((row, y) => {
    row.forEach((_, x) => {
      let k = xytok(x, y)
      let actual = digits.get(k)
      let expected = solution[y][x]
      if (expected !== undefined) {
        if (expected !== actual?.digit) {
          errors.add(k)
          if (actual?.digit === undefined) {
            ++missingDigits
          }
        } else if (actual?.given === false) {
          ++matchingDigits
        }
      }
    })
  })

  if (errors.size === 0) {
    return { type: "solved" }
  } else if (missingDigits === 0) {
    return { type: "wrongsolution", errors }
  } else if (missingDigits === errors.size) {
    if (matchingDigits > 0) {
      return { type: "goodsofar" }
    } else {
      return { type: "notstarted" }
    }
  }
  return { type: "badsofar" }
}

function gameReducerNoUndo(state: GameState, mode: string, action: Action) {
  switch (action.type) {
    case TYPE_MODE:
      modeReducer(state, action)
      return

    case TYPE_MODE_GROUP:
      modeGroupReducer(state, action)
      return

    case TYPE_FILL_CENTER_MARKS: {
      // This is a special action type that fills center marks for multiple cells in one go

      // First switch to center marks mode
      state.mode = MODE_CENTRE

      const cellsToProcess = (action as FillCenterMarksAction).cells

      // For each cell to process
      for (const cellK of cellsToProcess) {
        // Skip cells that already have a digit
        if (state.digits.get(cellK)) {
          continue
        }

        const [x, y] = ktoxy(cellK)

        // Find all digits 1-9 that are already present in the row, column, or 3x3 box
        const usedDigits = new Set<number>()

        // Check row
        for (let col = 0; col < 9; col++) {
          const k = xytok(col, y)
          const digit = state.digits.get(k)
          if (digit && typeof digit.digit === "number") {
            usedDigits.add(digit.digit)
          }
        }

        // Check column
        for (let row = 0; row < 9; row++) {
          const k = xytok(x, row)
          const digit = state.digits.get(k)
          if (digit && typeof digit.digit === "number") {
            usedDigits.add(digit.digit)
          }
        }

        // Check 3x3 box
        const boxStartX = Math.floor(x / 3) * 3
        const boxStartY = Math.floor(y / 3) * 3
        for (let row = boxStartY; row < boxStartY + 3; row++) {
          for (let col = boxStartX; col < boxStartX + 3; col++) {
            const k = xytok(col, row)
            const digit = state.digits.get(k)
            if (digit && typeof digit.digit === "number") {
              usedDigits.add(digit.digit)
            }
          }
        }

        // Add each available digit (1-9 that's not in usedDigits) as a center mark
        for (let digit = 1; digit <= 9; digit++) {
          if (!usedDigits.has(digit)) {
            let digits = state.centreMarks.get(cellK)
            if (digits === undefined) {
              digits = new Set()
              state.centreMarks.set(cellK, digits)
            }
            digits.add(digit)
          }
        }
      }

      return
    }

    case TYPE_DIGITS: {
      let filteredDigits: Map<number, Digit>
      if (state.data.fogLights !== undefined) {
        // ignore given digits covered by fog
        filteredDigits = new Map<number, Digit>()
        state.digits.forEach((v, k) => {
          let [x, y] = ktoxy(k)
          if (!v.given || !hasFog(state.fogRaster, x, y)) {
            filteredDigits.set(k, v)
          }
        })
      } else {
        // puzzle is not a fog puzzle - use all digits
        filteredDigits = state.digits
      }

      switch (mode) {
        case MODE_CORNER:
          marksReducer(
            state.cornerMarks,
            action,
            filterGivens(filteredDigits, state.selection),
            true,  // This is corner marks
            state  // Pass state for naked pair detection
          )
          return
        case MODE_CENTRE:
          marksReducer(
            state.centreMarks,
            action,
            filterGivens(filteredDigits, state.selection),
            false, // This is not corner marks
            state  // Pass state for consistency
          )
          return
      }

      let changed = digitsReducer(
        state.digits,
        action,
        filterGivens(filteredDigits, state.selection),
        state.cornerMarks,
        state.centreMarks,
      )

      if (changed) {
        // Automatically check if the puzzle is solved after placing a digit
        const errors = checkReducer(
          state.digits,
          state.data?.cells,
          state.data?.solution,
        )
        state.errors = errors
        state.solved = errors.type === "solved"
        state.checkCounter++

        if (state.data.fogLights !== undefined) {
          // update fog lights after digits have changed
          state.fogLights = makeFogLights(state.data, state.digits)
          state.fogRaster = makeFogRaster(state.data, state.fogLights)
        }
      }

      return
    }

    case TYPE_COLOURS:
      coloursReducer(state.colours, action, state.selection)
      return

    case TYPE_PENLINES:
      penLinesReducer(state.penLines, action)
      return

    case TYPE_SELECTION:
      selectionReducer(
        state.selection,
        action as SelectionAction,
        state.data?.cells,
      )
      return
  }
}

function makeUndoState(state: PersistentGameState): PersistentGameState {
  return {
    digits: state.digits,
    cornerMarks: state.cornerMarks,
    centreMarks: state.centreMarks,
    colours: state.colours,
    penLines: state.penLines,
    fogLights: state.fogLights,
    fogRaster: state.fogRaster,
  }
}

// Helper functions for serializing/deserializing game state
const STORAGE_KEY_PREFIX = "sudocle_game_"

// Convert Maps and Sets to arrays for JSON serialization
function serializeGameState(
  state: PersistentGameState,
  puzzleId: string,
): string {
  // Create a serializable version of the state
  const serialized = {
    digits: Array.from(state.digits.entries()),
    cornerMarks: Array.from(state.cornerMarks.entries()).map(([k, v]) => [
      k,
      Array.from(v),
    ]),
    centreMarks: Array.from(state.centreMarks.entries()).map(([k, v]) => [
      k,
      Array.from(v),
    ]),
    colours: Array.from(state.colours.entries()),
    penLines: Array.from(state.penLines),
    fogLights: state.fogLights,
    fogRaster: state.fogRaster,
    puzzleId,
  }

  return JSON.stringify(serialized)
}

// Convert arrays back to Maps and Sets when deserializing
function deserializeGameState(json: string): [PersistentGameState, string] {
  try {
    const parsed = JSON.parse(json)

    // Extract the puzzle ID
    const puzzleId = parsed.puzzleId || ""

    // Recreate the state with proper Maps and Sets
    const state: PersistentGameState = {
      digits: new Map(parsed.digits),
      cornerMarks: new Map(
        parsed.cornerMarks.map(([k, v]: [number, Array<number | string>]) => [
          k,
          new Set(v),
        ]),
      ),
      centreMarks: new Map(
        parsed.centreMarks.map(([k, v]: [number, Array<number | string>]) => [
          k,
          new Set(v),
        ]),
      ),
      colours: new Map(parsed.colours),
      penLines: new Set(parsed.penLines),
      fogLights: parsed.fogLights,
      fogRaster: parsed.fogRaster,
    }

    return [state, puzzleId]
  } catch (e) {
    console.error("Failed to deserialize game state:", e)
    return [
      {
        digits: new Map(),
        cornerMarks: new Map(),
        centreMarks: new Map(),
        colours: new Map(),
        penLines: new Set(),
      },
      "",
    ]
  }
}

// Get the current puzzle ID from the URL
function getCurrentPuzzleId(): string {
  if (typeof window === "undefined") return ""

  let id = window.location.pathname

  // Process the path
  if (process.env.__NEXT_ROUTER_BASEPATH) {
    id = id.substring(process.env.__NEXT_ROUTER_BASEPATH.length)
  }
  if (id.endsWith("/")) {
    id = id.substring(0, id.length - 1)
  }
  if (id.startsWith("/")) {
    id = id.substring(1)
  }

  // Extract the last part of the path as the puzzle ID
  const pathParts = id.split("/")
  id = pathParts.length > 0 ? pathParts[pathParts.length - 1] : ""

  // Check URL params if path is empty
  if (!id) {
    const params = new URLSearchParams(window.location.search)
    const puzzleId = params.get("puzzleid")
    const fpuzzlesId = params.get("fpuzzles")
    const fpuz = params.get("fpuz")
    const ctcId = params.get("ctc")
    const sclId = params.get("scl")

    if (fpuzzlesId) return "fpuzzles" + fpuzzlesId
    if (fpuz) return "fpuz" + fpuz
    if (ctcId) return "ctc" + ctcId
    if (sclId) return "scl" + sclId
    if (puzzleId) return puzzleId

    const testId = params.get("test")
    if (testId) return "test"
  }

  return id
}

// Save game state to localStorage
function saveGameState(state: GameState) {
  if (typeof window === "undefined") return

  const puzzleId = getCurrentPuzzleId()
  if (!puzzleId || !state.data || state.data.cells.length === 0) return

  try {
    const serialized = serializeGameState(state, puzzleId)
    localStorage.setItem(STORAGE_KEY_PREFIX + puzzleId, serialized)
  } catch (e) {
    console.error("Failed to save game state:", e)
  }
}

// Load game state from localStorage
function loadGameState(puzzleId: string): PersistentGameState | null {
  if (typeof window === "undefined" || !puzzleId) return null

  try {
    const json = localStorage.getItem(STORAGE_KEY_PREFIX + puzzleId)
    if (!json) return null

    const [state, storedPuzzleId] = deserializeGameState(json)

    // Only restore if the stored puzzle ID matches
    if (storedPuzzleId === puzzleId) {
      return state
    }
    return null
  } catch (e) {
    console.error("Failed to load game state:", e)
    return null
  }
}

export const useGame = create<GameStateWithActions>()(
  immer((set, get) => ({
    ...makeEmptyState(),

    updateGame: (action: Action) =>
      set(draft => {
        // After each action, save the game state
        setTimeout(() => {
          saveGameState(get())
        }, 0)
        if (action.type === TYPE_INIT) {
          let canonicalData:
            | {
                -readonly [P in keyof Data]: Data[P]
              }
            | undefined = undefined
          if (action.data !== undefined) {
            // Filter out invalid elements. For the time being, these are only
            // lines and arrows without colour or waypoints. In the future, we
            // might implement more rules or check the schema against our data
            // model.
            let data = { ...action.data }
            if (
              data.lines !== undefined &&
              Array.isArray(data.lines) &&
              data.lines.some(
                (l: any) => l.color === undefined || l.wayPoints === undefined,
              )
            ) {
              data.lines = data.lines.filter(
                (l: any) => l.color !== undefined && l.wayPoints !== undefined,
              )
            }
            if (
              data.gridLines !== undefined &&
              Array.isArray(data.gridLines) &&
              data.gridLines.some(
                (l: any) => l.color === undefined || l.wayPoints === undefined,
              )
            ) {
              data.gridLines = data.gridLines.filter(
                (l: any) => l.color !== undefined && l.wayPoints !== undefined,
              )
            }
            if (
              data.arrows !== undefined &&
              Array.isArray(data.arrows) &&
              data.arrows.some(
                (a: any) => a.color === undefined || a.wayPoints === undefined,
              )
            ) {
              data.arrows = data.arrows.filter(
                (a: any) => a.color !== undefined && a.wayPoints !== undefined,
              )
            }

            canonicalData = data as Data
            canonicalData.cells = canonicalData.cells || []
            canonicalData.regions = canonicalData.regions || []
            canonicalData.cages = canonicalData.cages || []
            canonicalData.lines = canonicalData.lines || []
            canonicalData.arrows = canonicalData.arrows || []
            canonicalData.underlays = canonicalData.underlays || []
            canonicalData.overlays = canonicalData.overlays || []

            // look for additional embedded attributes
            let possibleTitles: string[] = []
            let needToFilterFogLights = false
            for (let cage of canonicalData.cages) {
              if (typeof cage.value === "string") {
                if (cage.value.startsWith("title:")) {
                  canonicalData.title =
                    canonicalData.title ?? cage.value.substring(6).trim()
                } else if (cage.value.startsWith("author:")) {
                  canonicalData.author =
                    canonicalData.author ?? cage.value.substring(7).trim()
                } else if (cage.value.startsWith("rules:")) {
                  canonicalData.rules =
                    canonicalData.rules ?? cage.value.substring(6).trim()
                } else if (cage.value.startsWith("foglight:")) {
                  let str = cage.value.substring(9).trim()
                  canonicalData.fogLights = [
                    ...(canonicalData.fogLights ?? []),
                    ...parseFogLights(str),
                  ]
                } else if (cage.value.startsWith("solution:")) {
                  let str = cage.value.substring(9).trim()
                  canonicalData.solution =
                    canonicalData.solution ??
                    parseSolution(canonicalData.cells, str)
                } else if (cage.value.startsWith("msgcorrect:")) {
                  // Message to be displayed if solution is correct. This is not
                  // implemented yet. Ignore it.
                } else if (cage.value.toLowerCase() === "foglight") {
                  canonicalData.fogLights = [
                    ...(canonicalData.fogLights ?? []),
                    ...(cage.cells ?? []).map<FogLight>(c => ({
                      center: c,
                      size: 1,
                    })),
                  ]
                  needToFilterFogLights = true
                } else {
                  possibleTitles.push(cage.value)
                }
              }
            }
            if (
              canonicalData.title === undefined &&
              possibleTitles.length > 0
            ) {
              canonicalData.title = possibleTitles[0]
            }
            if (needToFilterFogLights) {
              canonicalData.cages = canonicalData.cages.filter(
                c =>
                  typeof c.value !== "string" ||
                  c.value.toLowerCase() !== "foglight",
              )
            }
            if (canonicalData.rules !== undefined) {
              // fix invalid line breaks in rules
              canonicalData.rules = canonicalData.rules.replaceAll(/\\n/g, "\n")
            }
          }

          // Create the base state from the puzzle data
          const baseState = makeEmptyState(canonicalData)

          // Try to load saved state for this puzzle
          const puzzleId = getCurrentPuzzleId()
          const savedState = loadGameState(puzzleId)

          // If we have saved state for this puzzle, merge it in
          if (savedState) {
            return {
              ...baseState,
              digits: savedState.digits,
              cornerMarks: savedState.cornerMarks,
              centreMarks: savedState.centreMarks,
              colours: savedState.colours,
              penLines: savedState.penLines,
              fogLights: savedState.fogLights || baseState.fogLights,
              fogRaster: savedState.fogRaster || baseState.fogRaster,
            }
          }

          return baseState
        }

        if (action.type !== TYPE_PAUSE && draft.paused) {
          // ignore any interaction when paused
          return
        }

        // clear errors on every interaction
        if (draft.errors.type !== "unknown") {
          draft.errors = { type: "unknown" }
        }

        if (action.type === TYPE_UNDO) {
          if (draft.nextUndoState === 0) {
            return
          }
          let oldState = draft.undoStates[draft.nextUndoState - 1]
          if (draft.nextUndoState === draft.undoStates.length) {
            draft.undoStates.push(makeUndoState(draft))
          }
          Object.assign(draft, makeUndoState(oldState))
          draft.nextUndoState = draft.nextUndoState - 1
          return
        }

        if (action.type === TYPE_REDO) {
          if (draft.nextUndoState >= draft.undoStates.length - 1) {
            return
          }
          let oldState = draft.undoStates[draft.nextUndoState + 1]
          Object.assign(draft, makeUndoState(oldState))
          draft.nextUndoState = draft.nextUndoState + 1
          return
        }

        if (action.type === TYPE_CHECK) {
          draft.errors = checkReducer(
            draft.digits,
            draft.data?.cells,
            draft.data?.solution,
          )
          draft.solved = draft.errors.type === "solved"
          draft.checkCounter++
          return
        }

        if (action.type === TYPE_PAUSE) {
          draft.paused = !draft.paused
          return
        }

        if (
          (action.type === TYPE_DIGITS || action.type === TYPE_COLOURS) &&
          action.action === ACTION_REMOVE
        ) {
          let deleteColour = false
          if (draft.mode === MODE_COLOUR) {
            for (let sc of draft.selection) {
              deleteColour = draft.colours.has(sc)
              if (deleteColour) {
                break
              }
            }
          }
          let highest = MODE_COLOUR
          if (!deleteColour) {
            for (let sc of draft.selection) {
              let digit = draft.digits.get(sc)
              if (digit !== undefined && (!digit.given || digit.discovered)) {
                highest = MODE_NORMAL
                break
              }
              if (highest === MODE_COLOUR && draft.centreMarks.has(sc)) {
                highest = MODE_CENTRE
              } else if (highest === MODE_COLOUR && draft.cornerMarks.has(sc)) {
                highest = MODE_CENTRE
              }
            }
            if (highest === MODE_CENTRE) {
              gameReducerNoUndo(draft, MODE_CORNER, action)
            }
          }
          if (highest === MODE_COLOUR) {
            gameReducerNoUndo(draft, highest, { ...action, type: TYPE_COLOURS })
          } else {
            gameReducerNoUndo(draft, highest, action)
          }
        } else {
          gameReducerNoUndo(draft, draft.mode, action)
        }

        let us = makeUndoState(get())
        let nus = makeUndoState(draft)
        if (
          !isEqual(us, nus) &&
          (draft.nextUndoState === 0 ||
            !isEqual(draft.undoStates[draft.nextUndoState - 1], us))
        ) {
          let newUndoStates = draft.undoStates.slice(0, draft.nextUndoState)
          newUndoStates[draft.nextUndoState] = us
          draft.undoStates = newUndoStates
          draft.nextUndoState = draft.nextUndoState + 1
        }
      }),
  })),
)
