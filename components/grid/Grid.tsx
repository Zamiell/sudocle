import { useAsyncEffect } from "../hooks/useAsyncEffect"
import { GameState, useGame } from "../hooks/useGame"
import { useSettings } from "../hooks/useSettings"
import {
  ACTION_CLEAR,
  ACTION_PUSH,
  ACTION_REMOVE,
  ACTION_SET,
  PenLinesAction,
  SelectionAction,
  TYPE_DIGITS,
  TYPE_FILL_CENTER_MARKS,
  TYPE_MODE,
  TYPE_PENLINES,
  TYPE_SELECTION,
} from "../lib/Actions"
import { MODE_CENTRE, MODE_PEN } from "../lib/Modes"
import { getRGBColor } from "../lib/colorutils"
import { hasFog, ktoxy, pltok, xytok } from "../lib/utils"
import { Arrow, DataCell, FogLight, Line, Overlay } from "../types/Data"
import { Digit } from "../types/Game"
import ArrowElement from "./ArrowElement"
import BackgroundImageElement from "./BackgroundImageElement"
import CageElement, { GridCage } from "./CageElement"
import CellElement from "./CellElement"
import { calculateCellExtent } from "./CellExtent"
import CentreMarksElement from "./CentreMarksElement"
import ColourElement from "./ColourElement"
import CornerMarksElement from "./CornerMarksElement"
import DigitElement from "./DigitElement"
import ExtraRegionElement, { GridExtraRegion } from "./ExtraRegionElement"
import { GridElement } from "./GridElement"
import LineElement from "./LineElement"
import OverlayElement from "./OverlayElement"
import RegionElement from "./RegionElement"
import SVGPathElement from "./SVGPathElement"
import { ThemeColours } from "./ThemeColours"
import { produce } from "immer"
import { flatten } from "lodash"
import memoizeOne from "memoize-one"
import { DropShadowFilter } from "pixi-filters/drop-shadow"
import {
  Application,
  Bounds,
  Container,
  FederatedPointerEvent,
  Graphics,
  Rectangle,
  Ticker,
} from "pixi.js"
import polygonClipping, { Polygon } from "polygon-clipping"
import {
  MouseEvent,
  MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react"
import { useShallow } from "zustand/react/shallow"

export const SCALE_FACTOR = 1.2
const ZOOM_DELTA = 0.05
const FONT_SIZE_DIGITS = 40
const FONT_SIZE_CORNER_MARKS_HIGH_DPI = 27
const FONT_SIZE_CORNER_MARKS_LOW_DPI = 28
const FONT_SIZE_CENTRE_MARKS_HIGH_DPI = 29
const FONT_SIZE_CENTRE_MARKS_LOW_DPI = 29
const MAX_RENDER_LOOP_TIME = 500

const PENLINE_TYPE_CENTER_RIGHT = 0
const PENLINE_TYPE_CENTER_DOWN = 1
const PENLINE_TYPE_EDGE_RIGHT = 2
const PENLINE_TYPE_EDGE_DOWN = 3

// TODO remove
interface OldGraphicsExData {
  k?: number
  draw: (options: {
    cellSize: number
    zoomFactor: number
    currentDigits: Map<number, Digit>
    currentFogLights: FogLight[] | undefined
    currentFogRaster: number[][] | undefined
    themeColours: ThemeColours
  }) => void
}

interface OldWithGraphicsExData {
  data?: OldGraphicsExData
}

// TODO remove
type OldGraphicsEx = Graphics & OldWithGraphicsExData

type PenWaypointGraphics = Graphics & {
  data?: {
    cellSize?: number
    draw: (options: {
      cellSize?: number
      penCurrentWaypoints: number[]
    }) => void
  }
}

function unionCells(cells: [number, number][]): number[][][] {
  let polys = cells.map(cell => {
    let y = cell[0]
    let x = cell[1]
    let r: Polygon = [
      [
        [x + 0, y + 0],
        [x + 1, y + 0],
        [x + 1, y + 1],
        [x + 0, y + 1],
      ],
    ]
    return r
  })

  let unions = polygonClipping.union(polys)
  for (let u of unions) {
    for (let p of u) {
      let f = p[0]
      let l = p[p.length - 1]
      if (f[0] === l[0] && f[1] === l[1]) {
        p.splice(p.length - 1, 1)
      }
    }
  }

  // merge holes into outer polygon if there is a shared point
  for (let u of unions) {
    let hi = 1
    while (hi < u.length) {
      let hole = u[hi]
      for (let spi = 0; spi < hole.length; ++spi) {
        let ph = hole[spi]
        let sharedPoint = u[0].findIndex(
          pu => pu[0] === ph[0] && pu[1] === ph[1],
        )
        if (sharedPoint >= 0) {
          // we found a shared point - merge hole into outer polygon
          u[0] = [
            ...u[0].slice(0, sharedPoint),
            ...hole.slice(spi),
            ...hole.slice(0, spi),
            ...u[0].slice(sharedPoint),
          ]

          // delete merged hole
          u.splice(hi, 1)
          --hi
          break
        }
      }
      ++hi
    }
  }

  return unions.map(u => u.map(u2 => flatten(u2)))
}

function hasCageValue(x: number, y: number, cages: GridCage[]): boolean {
  for (let cage of cages) {
    if (
      cage.topleft[0] === y &&
      cage.topleft[1] === x &&
      cage.value !== undefined &&
      cage.value !== ""
    ) {
      return true
    }
  }
  return false
}

function hasGivenCornerMarks(cell: DataCell): boolean {
  if (cell.pencilMarks === undefined) {
    return false
  }
  if (Array.isArray(cell.pencilMarks) && cell.pencilMarks.length === 0) {
    return false
  }
  return cell.pencilMarks !== ""
}

function euclidianBresenhamInterpolate(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number][] {
  let dx = Math.abs(x1 - x0)
  let sx = x0 < x1 ? 1 : -1
  let dy = -Math.abs(y1 - y0)
  let sy = y0 < y1 ? 1 : -1
  let err = dx + dy

  let result: [number, number][] = []
  while (true) {
    if (x0 === x1 && y0 === y1) {
      break
    }
    let e2 = 2 * err
    if (e2 > dy) {
      err += dy
      x0 += sx
      result.push([x0, y0])
    }
    if (e2 < dx) {
      err += dx
      y0 += sy
      result.push([x0, y0])
    }
  }
  result.pop()
  return result
}

function getThemeColour(style: CSSStyleDeclaration, color: string): number {
  return getRGBColor(`rgb(${style.getPropertyValue(color)})`)
}

function getThemeColours(elem: Element): ThemeColours {
  let rootStyle = window.getComputedStyle(elem)
  let backgroundColor = getThemeColour(rootStyle, "--bg")
  let foregroundColor = getThemeColour(rootStyle, "--fg")
  let digitColor = getThemeColour(rootStyle, "--digit")
  let smallDigitColor = getThemeColour(rootStyle, "--digit-small")

  let selectionYellow = getThemeColour(rootStyle, "--selection-yellow")
  let selectionRed = getThemeColour(rootStyle, "--selection-red")
  let selectionBlue = getThemeColour(rootStyle, "--selection-blue")
  let selectionGreen = getThemeColour(rootStyle, "--selection-green")

  return {
    backgroundColor,
    foregroundColor,
    digitColor,
    smallDigitColor,
    selection: {
      yellow: selectionYellow,
      red: selectionRed,
      green: selectionGreen,
      blue: selectionBlue,
    },
  }
}

function drawBackground(
  graphics: Graphics,
  width: number,
  height: number,
  themeColours: ThemeColours,
) {
  graphics.hitArea = new Rectangle(0, 0, width, height)
  graphics.rect(0, 0, width, height)
  graphics.fill(themeColours.backgroundColor)
}

function penWaypointsToKey(
  wp1: number,
  wp2: number,
  penCurrentDrawEdge: boolean,
): number | undefined {
  let right
  let down
  if (penCurrentDrawEdge) {
    right = PENLINE_TYPE_EDGE_RIGHT
    down = PENLINE_TYPE_EDGE_DOWN
  } else {
    right = PENLINE_TYPE_CENTER_RIGHT
    down = PENLINE_TYPE_CENTER_DOWN
  }
  let p1 = ktoxy(wp1)
  let p2 = ktoxy(wp2)
  if (p2[0] > p1[0]) {
    return pltok(p1[0], p1[1], right)
  } else if (p2[0] < p1[0]) {
    return pltok(p2[0], p2[1], right)
  } else if (p2[1] > p1[1]) {
    return pltok(p1[0], p1[1], down)
  } else if (p2[1] < p1[1]) {
    return pltok(p2[0], p2[1], down)
  }
  return undefined
}

interface FogDisplayOptions {
  /**
   * `true` if fog should be visible, `false` if it should be completely disabled
   */
  enableFog: boolean

  /**
   * `true` if the fog should have a drop shadow
   */
  enableDropShadow: boolean
}

interface GridProps {
  maxWidth: number
  maxHeight: number
  portrait: boolean
  onFinishRender: () => void
  fogDisplayOptions?: FogDisplayOptions
}

const Grid = ({
  maxWidth,
  maxHeight,
  portrait,
  onFinishRender,
  fogDisplayOptions = { enableFog: true, enableDropShadow: true },
}: GridProps) => {
  const ref = useRef<HTMLDivElement>(null)
  const gridElement = useRef<Container>(undefined)
  const cellsElement = useRef<Container>(undefined)
  const allElement = useRef<Container>(undefined)
  const cellElements = useRef<CellElement[]>([])
  const gridLineElements = useRef<(LineElement | SVGPathElement)[]>([])
  const regionElements = useRef<RegionElement[]>([])
  const cageElements = useRef<(CageElement | LineElement | SVGPathElement)[]>(
    [],
  )
  const lineElements = useRef<(LineElement | ArrowElement)[]>([])
  const svgPathElements = useRef<SVGPathElement[]>([])
  const extraRegionElements = useRef<ExtraRegionElement[]>([])
  const underlayElements = useRef<(OverlayElement | LineElement)[]>([])
  const overlayElements = useRef<
    (OverlayElement | LineElement | SVGPathElement)[]
  >([])
  const backgroundElement = useRef<Graphics>(undefined)
  const backgroundImageElements = useRef<BackgroundImageElement[]>([])
  const fogElements = useRef<OldGraphicsEx[]>([])
  const givenCornerMarkElements = useRef<CornerMarksElement[]>([])
  const digitElements = useRef<DigitElement[]>([])
  const centreMarkElements = useRef<CentreMarksElement[]>([])
  const cornerMarkElements = useRef<CornerMarksElement[]>([])
  const colourElements = useRef<ColourElement[]>([])
  const selectionElements = useRef<ColourElement[]>([])
  const errorElements = useRef<ColourElement[]>([])
  const penCurrentWaypoints = useRef<number[]>([])
  const penCurrentWaypointsAdd = useRef(true)
  const penCurrentWaypointsElements = useRef<PenWaypointGraphics[]>([])
  const penHitareaElements = useRef<OldGraphicsEx[]>([])
  const penCurrentDrawEdge = useRef(false)
  const penLineElements = useRef<OldGraphicsEx[]>([])

  const renderLoopStarted = useRef(0)
  const rendering = useRef(false)

  const game: GameState = useGame()
  const updateGame = useGame(state => state.updateGame)

  const {
    colourPalette,
    theme,
    selectionColour,
    customColours,
    zoom,
    fontSizeFactorDigits,
    fontSizeFactorCornerMarks,
    fontSizeFactorCentreMarks,
  } = useSettings(
    useShallow(state => ({
      colourPalette: state.colourPalette,
      theme: state.theme,
      selectionColour: state.selectionColour,
      customColours: state.customColours,
      zoom: state.zoom,
      fontSizeFactorDigits: state.fontSizeFactorDigits,
      fontSizeFactorCornerMarks: state.fontSizeFactorCornerMarks,
      fontSizeFactorCentreMarks: state.fontSizeFactorCentreMarks,
    })),
  )

  const currentMode = useRef(game.mode)

  const cellSize = game.data.cellSize * SCALE_FACTOR
  const cellSizeFactor = useRef(-1)

  let { result: app } = useAsyncEffect(
    async () => {
      // optimised resolution for different screens
      let resolution = Math.min(
        window.devicePixelRatio,
        window.devicePixelRatio === 2 ? 3 : 2.5,
      )

      let roundPixels: boolean | undefined = undefined
      if (window.devicePixelRatio < 2) {
        // good for dpi < 2
        roundPixels = true
      }

      // create PixiJS app
      let newApp = new Application()
      await newApp.init({
        resolution,
        antialias: true,
        backgroundAlpha: 0,
        autoDensity: true,
        autoStart: false,
        roundPixels,
      })
      if (!("_SUDOCLE_IS_TEST" in window)) {
        ref.current!.appendChild(newApp.canvas as any)
      }

      // it seems we don't need the system ticker, so stop it
      Ticker.system.stop()

      // Disable accessibility manager. We don't need it. Also, if it is enabled,
      // it creates an invisible div on top of our grid when the user presses the
      // tab key, which resets the cursor. We don't want the cursor to be reset!
      newApp.renderer.accessibility.destroy()

      return newApp
    },
    async () => {
      if (app !== undefined) {
        app.destroy(true, true)
      }
    },
    [],
  )

  const regions = useMemo(
    () =>
      flatten(
        game.data.regions.map(region => {
          return flatten(unionCells(region))
        }),
      ),
    [game.data],
  )

  const cages = useMemo<GridCage[]>(
    () =>
      flatten(
        game.data.cages
          .filter(cage => cage.cells !== undefined && cage.cells.length > 0)
          .map(cage => {
            let unions = flatten(unionCells(cage.cells!))
            return unions.map(union => {
              // find top-left cell
              let topleft = cage.cells![0]
              for (let cell of cage.cells!) {
                if (cell[0] < topleft[0]) {
                  topleft = cell
                } else if (cell[0] === topleft[0] && cell[1] < topleft[1]) {
                  topleft = cell
                }
              }

              return {
                outline: union,
                value: cage.value,
                borderColor: cage.borderColor,
                topleft,
              }
            })
          }),
      ),
    [game.data],
  )

  const extraRegions = useMemo<GridExtraRegion[]>(() => {
    if (Array.isArray(game.data.extraRegions)) {
      return flatten(
        game.data.extraRegions
          .filter(r => r.cells?.length)
          .map(r => {
            let unions = flatten(unionCells(r.cells))
            return unions.map(union => {
              return {
                outline: union,
                backgroundColor: r.backgroundColor,
              }
            })
          }),
      )
    } else {
      return []
    }
  }, [game.data])

  // Custom render loop. Render on demand and then repeat rendering for
  // MAX_RENDER_LOOP_TIME milliseconds. Then pause rendering again. This has
  // two benefits: (1) it forces the browser to refresh the screen as quickly
  // as possible (without this, there might be lags of 500ms - 1s every now
  // and then!), (2) it saves CPU cycles and therefore battery.
  const renderNow = useCallback(() => {
    if ("_SUDOCLE_IS_TEST" in window) {
      // don't render in tests - we will call screenshotNow() instead when
      // we are ready
      return
    }

    function doRender() {
      let elapsed = +new Date() - renderLoopStarted.current
      if (app !== undefined && elapsed < MAX_RENDER_LOOP_TIME) {
        rendering.current = true
        app.render()
        requestAnimationFrame(doRender)
      } else {
        rendering.current = false
      }
    }

    renderLoopStarted.current = +new Date()
    if (!rendering.current) {
      doRender()
    }
  }, [app])

  const screenshotNow = useCallback(() => {
    if (app !== undefined) {
      app.render()
      let url = app.canvas.toDataURL!()
      ;(window as any).screenshotRendered(url)
    }
  }, [app])

  const onPenMove = useCallback(
    (e: FederatedPointerEvent, cellSize: number) => {
      if (e.target === null) {
        // pointer is not over the hit area
        return
      }
      if (e.buttons !== 1) {
        // let mouse button is not pressed
        return
      }

      let gridBounds = gridElement.current!.getBounds()
      let x = e.global.x - gridBounds.x
      let y = e.global.y - gridBounds.y

      let fCellX = x / cellSize
      let fCellY = y / cellSize
      let cellX = Math.floor(fCellX)
      let cellY = Math.floor(fCellY)
      let cellDX = fCellX - cellX
      let cellDY = fCellY - cellY
      if (penCurrentWaypoints.current.length === 0) {
        // snap to cell edge or cell center
        if (
          cellDX >= 0.25 &&
          cellDX <= 0.75 &&
          cellDY >= 0.25 &&
          cellDY <= 0.75
        ) {
          penCurrentDrawEdge.current = false
        } else {
          penCurrentDrawEdge.current = true
          if (cellDX >= 0.5) {
            cellX++
          }
          if (cellDY >= 0.5) {
            cellY++
          }
        }
      } else {
        if (penCurrentDrawEdge.current) {
          if (cellDX >= 0.5) {
            cellX++
          }
          if (cellDY >= 0.5) {
            cellY++
          }
        }
      }

      let k = xytok(cellX, cellY)

      if (penCurrentWaypoints.current.length === 0) {
        penCurrentWaypoints.current = [k]
      } else if (
        penCurrentWaypoints.current[penCurrentWaypoints.current.length - 1] ===
        k
      ) {
        // nothing to do
        return
      } else {
        penCurrentWaypoints.current = produce(
          penCurrentWaypoints.current,
          pcw => {
            let toAdd = []
            if (pcw.length > 0) {
              let fp = pcw[pcw.length - 1]
              let fpp = ktoxy(fp)
              let dx = Math.abs(cellX - fpp[0])
              let dy = Math.abs(cellY - fpp[1])
              if (dx + dy !== 1) {
                // cursor was moved diagonally or jumped to a distant cell
                // interpolate between the last cell and the new one
                let interpolated = euclidianBresenhamInterpolate(
                  fpp[0],
                  fpp[1],
                  cellX,
                  cellY,
                )
                for (let ip of interpolated) {
                  toAdd.push(xytok(ip[0], ip[1]))
                }
              }
            }
            toAdd.push(k)

            // check if we've moved backwards and, if so, how much
            let matched = 0
            for (
              let a = pcw.length - 2, b = 0;
              a >= 0 && b < toAdd.length;
              --a, ++b
            ) {
              if (pcw[a] === toAdd[b]) {
                matched++
              } else {
                break
              }
            }
            if (matched > 0) {
              // remove as many waypoints as we've moved back
              pcw.splice(-matched)
            } else {
              // we did not move backwards - just add the new waypoints
              for (let ap of toAdd) {
                pcw.push(ap)
              }
            }
          },
        )

        // check if we are adding a pen line or removing it
        if (penCurrentWaypoints.current.length > 1) {
          let firstKey = penWaypointsToKey(
            penCurrentWaypoints.current[0],
            penCurrentWaypoints.current[1],
            penCurrentDrawEdge.current,
          )
          let visible = penLineElements.current.some(
            e => e.data?.k === firstKey && e.visible,
          )
          penCurrentWaypointsAdd.current = !visible
        }
      }

      // render waypoints
      penCurrentWaypointsElements.current.forEach(e =>
        e.data?.draw({ penCurrentWaypoints: penCurrentWaypoints.current }),
      )
      renderNow()
    },
    [renderNow],
  )

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      let digit = e.code.match("Digit([0-9])")
      if (digit) {
        let nd = +digit[1]
        updateGame({
          type: TYPE_DIGITS,
          action: ACTION_SET,
          digit: nd,
        })
        e.preventDefault()
      }

      let numpad = e.code.match("Numpad([0-9])")
      if (numpad && +e.key === +numpad[1]) {
        let nd = +numpad[1]
        updateGame({
          type: TYPE_DIGITS,
          action: ACTION_SET,
          digit: nd,
        })
        e.preventDefault()
      }

      if (e.key === "Backspace" || e.key === "Delete" || e.key === "Clear") {
        updateGame({
          type: TYPE_DIGITS,
          action: ACTION_REMOVE,
        })
      }

      // Add the "f" key shortcut to fill in center marks with valid possibilities
      if (e.key === "f" || e.key === "F") {
        // Only proceed if there's a selection with at least one cell
        if (game.selection.size > 0) {
          // Collect all cells that need processing
          const selectedCells = [...game.selection]

          // Use our new action type to handle everything in one go
          updateGame({
            type: TYPE_FILL_CENTER_MARKS,
            cells: selectedCells,
          })

          e.preventDefault()
        }
      }
    },
    [updateGame, game.selection, game.digits, game.mode],
  )

  function onBackgroundClick(e: MouseEvent) {
    e.stopPropagation()
  }

  function onDoubleClick(e: MouseEvent) {
    if (game.selection.size === 0 || !e.altKey) {
      return
    }

    // get color of last cell clicked
    let last = [...game.selection].pop()!
    let colour = game.colours.get(last)

    if (colour !== undefined) {
      // find all cells with the same colour
      let allCells = []
      for (let [k, c] of game.colours) {
        if (c.colour === colour.colour) {
          allCells.push(k)
        }
      }

      let action: SelectionAction["action"] =
        e.metaKey || e.ctrlKey ? ACTION_PUSH : ACTION_SET
      updateGame({
        type: TYPE_SELECTION,
        action,
        k: allCells,
      })
    }
  }

  const onPointerUp = useCallback(() => {
    if (penCurrentWaypoints.current.length > 0) {
      let penLines = []
      for (let i = 0; i < penCurrentWaypoints.current.length - 1; ++i) {
        let k = penWaypointsToKey(
          penCurrentWaypoints.current[i],
          penCurrentWaypoints.current[i + 1],
          penCurrentDrawEdge.current,
        )
        if (k !== undefined) {
          penLines.push(k)
        }
      }
      let action: PenLinesAction["action"]
      if (penCurrentWaypointsAdd.current) {
        action = ACTION_PUSH
      } else {
        action = ACTION_REMOVE
      }
      updateGame({
        type: TYPE_PENLINES,
        action,
        k: penLines,
      })
      penCurrentWaypoints.current = []
      penCurrentDrawEdge.current = false

      // render waypoints (this will basically remove them from the grid)
      penCurrentWaypointsElements.current.forEach(e =>
        e.data?.draw({ penCurrentWaypoints: penCurrentWaypoints.current }),
      )
      renderNow()
    }
  }, [updateGame, renderNow])

  useEffect(() => {
    currentMode.current = game.mode

    if (app !== undefined) {
      if (game.mode === MODE_PEN) {
        app.renderer.events.setCursor("crosshair")
      } else {
        app.renderer.events.setCursor("pointer")
      }
    }

    penHitareaElements.current.forEach(
      e => (e.visible = game.mode === MODE_PEN),
    )

    penCurrentWaypoints.current = []
  }, [app, game.mode])

  useEffect(() => {
    if (app === undefined) {
      return
    }

    // register touch handler
    document.addEventListener("pointerup", onPointerUp, false)
    document.addEventListener("pointercancel", onPointerUp, false)

    let defaultFontFamily = getComputedStyle(document.body).getPropertyValue(
      "--font-roboto",
    )

    // create grid
    let all = new Container()
    allElement.current = all
    let grid = new Container()
    gridElement.current = grid

    all.sortableChildren = true
    grid.sortableChildren = true

    // ***************** Layers and zIndexes:

    // all                            sortable
    //   background            -1000
    //   background image        -40
    //   extra regions           -30
    //   underlays               -20
    //   SVG paths               -15
    //   lines and arrows        -10
    //   arrow heads             -10
    //   fog                      -1
    //   colour                    0
    //   errors                   10
    //   selection                20
    //   grid                     30  sortable
    //     cells                   0
    //     grid lines              1
    //     cages                   2
    //     regions                10
    //   overlays                 40
    //   given corner marks       41
    //   digit                    50
    //   corner marks             50
    //   centre marks             50
    //   pen lines                60
    //   pen waypoints            70
    //   pen tool hitarea         80

    // ***************** render everything that could contribute to bounds

    // add fog
    let fogMask: OldGraphicsEx | null = null
    if (game.data.fogLights !== undefined) {
      let fog: OldGraphicsEx = new Graphics()
      fog.zIndex = -1
      fog.data = {
        draw: function ({ cellSize, currentFogRaster }) {
          if (currentFogRaster === undefined) {
            return
          }

          let flatCells: [number, number][] = []
          currentFogRaster.forEach((row, y) => {
            row.forEach((v, x) => {
              if (v === 1) {
                flatCells.push([y, x])
              }
            })
          })

          let polygons = unionCells(flatCells)
          for (let polygon of polygons) {
            let poly = polygon.map(o => o.map(r => r * cellSize))
            fog.poly(poly[0])
            fog.fill(0x8b909b)
            if (poly.length > 1) {
              for (let i = 1; i < poly.length; ++i) {
                fog.poly(poly[i])
              }
              fog.cut()
            }
          }
        },
      }
      if (fogDisplayOptions.enableDropShadow) {
        let dropShadow = new DropShadowFilter({
          offset: { x: 0, y: 0 },
          blur: 5,
          quality: 6,
          alpha: 0.9,
          color: 0x272e31,
        })
        dropShadow.padding = 20
        fog.filters = [dropShadow]
      }
      fogElements.current.push(fog)
      all.addChild(fog)

      fogMask = new Graphics()
      fogMask.data = {
        draw: function ({ cellSize, currentFogLights }) {
          if (currentFogLights !== undefined) {
            for (let light of currentFogLights) {
              let y = light.center[0]
              let x = light.center[1]
              if (light.size === 3) {
                fogMask!.rect(
                  (x - 1) * cellSize,
                  (y - 1) * cellSize,
                  cellSize * 3,
                  cellSize * 3,
                )
              } else {
                fogMask!.rect(x * cellSize, y * cellSize, cellSize, cellSize)
              }
            }
          }

          // always show area outside of grid
          fogMask!.rect(
            -5 * cellSize,
            -5 * cellSize,
            cellSize * 5,
            cellSize * (game.data.cells.length + 10),
          )
          fogMask!.rect(
            cellSize * game.data.cells[0].length,
            -5 * cellSize,
            cellSize * 5,
            cellSize * (game.data.cells.length + 10),
          )
          fogMask!.rect(
            0,
            -5 * cellSize,
            cellSize * game.data.cells[0].length,
            cellSize * 5,
          )
          fogMask!.rect(
            0,
            cellSize * game.data.cells.length,
            cellSize * game.data.cells[0].length,
            cellSize * 5,
          )

          fogMask!.fill(0)
        },
      }
      fogElements.current.push(fogMask)
      all.addChild(fogMask)
    }

    // add cells
    let cells = new Container()
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let cell = new CellElement(x, y, game.data.settings?.nogrid ?? false)
        cells.addChild(cell.graphics)
        cellElements.current.push(cell)
      })
    })
    cellsElement.current = cells
    grid.addChild(cells)

    // add lines with target "cell-grids"
    let gridLinesContainer = new Container()
    gridLinesContainer.zIndex = 1
    let gridLines = game.data.lines.filter(l => l.target === "cell-grids")
    gridLines.forEach(line => {
      let l = new LineElement(line, gridLines, [], false)
      gridLinesContainer.addChild(l.container)
      gridLineElements.current.push(l)
    })

    // add svg paths with target "cell-grids"
    game.data.svgPaths
      ?.filter(p => p.target === "cell-grids")
      ?.forEach(p => {
        let l = new SVGPathElement(p)
        gridLinesContainer.addChild(l.container)
        gridLineElements.current.push(l)
      })
    grid.addChild(gridLinesContainer)

    // add regions
    let regionContainer = new Container()
    regionContainer.zIndex = 10
    for (let r of regions) {
      let region = new RegionElement(r)
      regionContainer.addChild(region.graphics)
      regionElements.current.push(region)
    }
    grid.addChild(regionContainer)

    // add cages
    let cageContainer = new Container()
    cageContainer.zIndex = 2
    cageContainer.mask = fogMask
    for (let cage of cages) {
      let c = new CageElement(cage, regions, defaultFontFamily, 13)
      cageContainer.addChild(c.container)
      cageElements.current.push(c)
    }
    grid.addChild(cageContainer)

    // add lines with target "cages"
    let cageLines = game.data.lines.filter(l => l.target === "cages")
    cageLines.forEach(line => {
      let l = new LineElement(line, cageLines, [], false)
      cageContainer.addChild(l.container)
      cageElements.current.push(l)
    })

    // add svg paths with target "cages"
    game.data.svgPaths
      ?.filter(p => p.target === "cages")
      ?.forEach(p => {
        let l = new SVGPathElement(p)
        cageContainer.addChild(l.container)
        cageElements.current.push(l)
      })

    grid.zIndex = 30
    all.addChild(grid)

    // add extra regions
    let extraRegionContainer = new Container()
    extraRegionContainer.zIndex = -30
    extraRegionContainer.mask = fogMask
    for (let r of extraRegions) {
      let er = new ExtraRegionElement(r, regions)
      extraRegionContainer.addChild(er.graphics)
      extraRegionElements.current.push(er)
    }
    all.addChild(extraRegionContainer)

    // add SVG paths
    let svgPathsWithoutTarget = game.data.svgPaths?.filter(
      p => p.target === undefined,
    )
    let svgPathsContainer = new Container()
    svgPathsContainer.zIndex = -15
    svgPathsContainer.mask = fogMask
    svgPathsWithoutTarget?.forEach(p => {
      let l = new SVGPathElement(p)
      svgPathsContainer.addChild(l.container)
      svgPathElements.current.push(l)
    })
    all.addChild(svgPathsContainer)

    // find lines without a target
    let linesWithoutTarget = game.data.lines.filter(l => l.target === undefined)

    // sort lines and arrows by thickness
    let lines: (
      | {
          line: Line
          arrow?: never
        }
      | {
          line?: never
          arrow: Arrow
        }
    )[] = [
      ...linesWithoutTarget.map(l => ({ line: l })),
      ...game.data.arrows.map(a => ({ arrow: a })),
    ]
    lines.sort(
      (a, b) =>
        (b.line !== undefined ? b.line.thickness : b.arrow.thickness) -
        (a.line !== undefined ? a.line.thickness : a.arrow.thickness),
    )

    // add lines and arrows
    let linesContainer = new Container()
    linesContainer.zIndex = -10
    linesContainer.mask = fogMask
    lines.forEach(line => {
      let overlays = [
        ...game.data.underlays,
        ...game.data.overlays.flatMap(o => ("center" in o ? [o] : [])),
      ]
      if (line.line !== undefined) {
        let l = new LineElement(line.line, game.data.lines, overlays)
        linesContainer.addChild(l.container)
        lineElements.current.push(l)
      } else if (line.arrow.wayPoints.length > 1) {
        let a = new ArrowElement(line.arrow, overlays)
        linesContainer.addChild(a.container)
        lineElements.current.push(a)
      }
    })
    all.addChild(linesContainer)

    // add underlays: lines with target "underlay"
    let underlaysContainer = new Container()
    underlaysContainer.zIndex = -20
    underlaysContainer.mask = fogMask
    let underlayLines = game.data.lines.filter(l => l.target === "underlay")
    underlayLines.forEach(l => {
      let o = new LineElement(l, underlayLines, [])
      underlaysContainer.addChild(o.container)
      underlayElements.current.push(o)
    })

    // add other underlays
    game.data.underlays.forEach(underlay => {
      let o = new OverlayElement(underlay, defaultFontFamily)
      underlaysContainer.addChild(o.container)
      underlayElements.current.push(o)
    })
    all.addChild(underlaysContainer)

    // add overlays: SVG paths with target "overlay"
    let overlaysContainer = new Container()
    overlaysContainer.zIndex = 40
    overlaysContainer.mask = fogMask
    let overlaySvgPaths = game.data.svgPaths?.filter(
      l => l.target === "overlay",
    )
    overlaySvgPaths?.forEach(p => {
      let o = new SVGPathElement(p)
      overlaysContainer.addChild(o.container)
      overlayElements.current.push(o)
    })

    // add overlays: lines with target "overlay"
    let overlayLines = game.data.lines.filter(l => l.target === "overlay")
    overlayLines.forEach(l => {
      let o = new LineElement(l, overlayLines, [])
      overlaysContainer.addChild(o.container)
      overlayElements.current.push(o)
    })

    // add other overlays
    game.data.overlays.forEach(overlay => {
      let o = new OverlayElement(overlay, defaultFontFamily)
      overlaysContainer.addChild(o.container)
      overlayElements.current.push(o)
    })
    all.addChild(overlaysContainer)

    // draw a background that covers all elements
    let background = new Graphics()
    background.eventMode = "static"
    background.zIndex = -1000
    background.on("pointerdown", () => {
      if (currentMode.current !== MODE_PEN) {
        updateGame({
          type: TYPE_SELECTION,
          action: ACTION_CLEAR,
        })
      }
    })
    backgroundElement.current = background
    app.stage.addChild(background)

    // add background image
    if (game.data.metadata?.bgimage !== undefined) {
      let bgContainer = new Container()
      bgContainer.zIndex = -40
      bgContainer.mask = fogMask

      let extent = calculateCellExtent(game.data)
      let bg = new BackgroundImageElement(
        game.data.metadata?.bgimage,
        game.data.metadata.bgimageopacity ?? 0.2,
        extent,
      )
      bgContainer.addChild(bg.container)
      backgroundImageElements.current.push(bg)

      all.addChild(bgContainer)
    }

    app.stage.addChild(all)

    // ***************** draw other elements that don't contribute to the bounds

    let themeColours = getThemeColours(ref.current!)

    // create text elements for given corner marks
    let givenCornerMarksContainer = new Container()
    givenCornerMarksContainer.zIndex = 41
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let pms = col.pencilMarks
        if (pms === undefined) {
          return
        }
        let arr: (string | number)[]
        if (Array.isArray(pms)) {
          arr = pms
        } else {
          arr = [pms]
        }

        let cm = new CornerMarksElement(
          arr.length,
          x,
          y,
          hasCageValue(x, y, cages),
          defaultFontFamily,
          FONT_SIZE_CORNER_MARKS_HIGH_DPI,
          "700",
          themeColours.foregroundColor,
        )

        for (let i = 0; i < arr.length; ++i) {
          cm.setValue(i, arr[i])
        }

        givenCornerMarksContainer.addChild(cm.container)
        givenCornerMarkElements.current.push(cm)
      })
    })
    all.addChild(givenCornerMarksContainer)

    // ***************** draw invisible elements but don't call render() again!

    // create empty text elements for all digits
    let digitsContainer = new Container()
    digitsContainer.zIndex = 50
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let d = new DigitElement(x, y, defaultFontFamily, FONT_SIZE_DIGITS)
        d.visible = false
        digitsContainer.addChild(d.text)
        digitElements.current.push(d)
      })
    })
    all.addChild(digitsContainer)

    // create empty text elements for corner marks
    let cornerMarksContainer = new Container()
    cornerMarksContainer.zIndex = 50
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let leaveRoom = hasCageValue(x, y, cages) || hasGivenCornerMarks(col)
        let cm = new CornerMarksElement(
          11,
          x,
          y,
          leaveRoom,
          defaultFontFamily,
          FONT_SIZE_CORNER_MARKS_HIGH_DPI,
          "normal",
          themeColours.digitColor,
        )

        cm.setAllVisible(false)

        cornerMarksContainer.addChild(cm.container)
        cornerMarkElements.current.push(cm)
      })
    })
    all.addChild(cornerMarksContainer)

    // create empty text elements for centre marks
    let centreMarksContainer = new Container()
    centreMarksContainer.zIndex = 50
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let ce = new CentreMarksElement(
          x,
          y,
          defaultFontFamily,
          FONT_SIZE_CENTRE_MARKS_HIGH_DPI,
          themeColours.digitColor,
        )

        ce.visible = false

        centreMarksContainer.addChild(ce.text)
        centreMarkElements.current.push(ce)
      })
    })
    all.addChild(centreMarksContainer)

    // create invisible rectangles for colours
    let colourContainer = new Container()
    colourContainer.zIndex = 0
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let ce = new ColourElement(x, y, 0)
        colourContainer.addChild(ce.graphics)
        colourElements.current.push(ce)
      })
    })
    all.addChild(colourContainer)

    // create invisible rectangles for selection
    let selectionContainer = new Container()
    selectionContainer.zIndex = 20
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let se = new ColourElement(x, y, 0xffde2a)
        selectionContainer.addChild(se.graphics)
        selectionElements.current.push(se)
      })
    })
    all.addChild(selectionContainer)

    // create invisible rectangles for errors
    let errorContainer = new Container()
    errorContainer.zIndex = 10
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let se = new ColourElement(x, y, 0xb33a3a)
        errorContainer.addChild(se.graphics)
        errorElements.current.push(se)
      })
    })
    all.addChild(errorContainer)

    // create invisible elements for pen lines
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        function makeLine(
          rx: number,
          ry: number,
          horiz: boolean,
          dx: number,
          dy: number,
          type: number,
        ) {
          let line: OldGraphicsEx = new Graphics()
          line.visible = false
          line.zIndex = 60
          line.data = {
            k: pltok(rx, ry, type),
            draw: function ({ cellSize }) {
              line.moveTo(0, 0)
              if (horiz) {
                line.lineTo(cellSize, 0)
              } else {
                line.lineTo(0, cellSize)
              }
              line.x = (rx + dx) * cellSize
              line.y = (ry + dy) * cellSize
              line.stroke({
                width: 2 * SCALE_FACTOR,
                color: 0,
                cap: "round",
                join: "round",
              })
            },
          }
          all.addChild(line)
          penLineElements.current.push(line)
        }

        if (x < row.length - 1) {
          makeLine(x, y, true, 0.5, 0.5, PENLINE_TYPE_CENTER_RIGHT)
        }
        makeLine(x, y, true, 0, 0, PENLINE_TYPE_EDGE_RIGHT)
        if (y === game.data.cells.length - 1) {
          makeLine(x, y + 1, true, 0, 0, PENLINE_TYPE_EDGE_RIGHT)
        }
        if (y < game.data.cells.length - 1) {
          makeLine(x, y, false, 0.5, 0.5, PENLINE_TYPE_CENTER_DOWN)
        }
        makeLine(x, y, false, 0, 0, PENLINE_TYPE_EDGE_DOWN)
        if (x === row.length - 1) {
          makeLine(x + 1, y, false, 0, 0, PENLINE_TYPE_EDGE_DOWN)
        }
      })
    })

    // create element that visualises current pen waypoints
    let penWaypoints: PenWaypointGraphics = new Graphics()
    penWaypoints.zIndex = 70
    penWaypoints.data = {
      draw: function ({ cellSize, penCurrentWaypoints }) {
        let that = penWaypoints.data!
        that.cellSize = cellSize ?? that.cellSize
        if (that.cellSize === undefined) {
          return
        }

        penWaypoints.clear()
        if (penCurrentWaypoints.length > 1) {
          let color
          if (penCurrentWaypointsAdd.current) {
            color = 0x009e73
          } else {
            color = 0xde3333
          }
          let d = 0.5
          if (penCurrentDrawEdge.current) {
            d = 0
          }
          let p0 = ktoxy(penCurrentWaypoints[0])
          penWaypoints.moveTo(
            (p0[0] + d) * that.cellSize,
            (p0[1] + d) * that.cellSize,
          )
          for (let i = 0; i < penCurrentWaypoints.length - 1; ++i) {
            let p = ktoxy(penCurrentWaypoints[i + 1])
            penWaypoints.lineTo(
              (p[0] + d) * that.cellSize,
              (p[1] + d) * that.cellSize,
            )
          }
          penWaypoints.stroke({
            width: 3 * SCALE_FACTOR,
            color,
            cap: "round",
            join: "round",
          })
        }
      },
    }
    all.addChild(penWaypoints)
    penCurrentWaypointsElements.current.push(penWaypoints)

    // add invisible hit area for pen tool
    let penHitArea: OldGraphicsEx = new Graphics()
    penHitArea.eventMode = "static"
    penHitArea.cursor = "crosshair"
    penHitArea.zIndex = 80
    penHitArea.visible = false
    penHitArea.data = {
      draw: function ({ cellSize }) {
        penHitArea.hitArea = new Rectangle(
          0,
          0,
          game.data.cells[0].length * cellSize,
          game.data.cells.length * cellSize,
        )
        penHitArea.removeAllListeners()
        penHitArea.on("pointermove", e => onPenMove(e, cellSize))
      },
    }
    all.addChild(penHitArea)
    penHitareaElements.current.push(penHitArea)

    // memoize draw calls to improve performance
    // TODO remove
    const oldWrapDraw =
      (
        e: OldWithGraphicsExData,
        draw: NonNullable<OldWithGraphicsExData["data"]>["draw"],
      ): NonNullable<OldWithGraphicsExData["data"]>["draw"] =>
      options => {
        if (e instanceof Graphics) {
          e.clear()
        }
        draw(options)
      }
    let oldElementsToMemoize = [
      fogElements,
      penLineElements,
      penHitareaElements,
    ]
    for (let r of oldElementsToMemoize) {
      for (let e of r.current) {
        if (e.data?.draw !== undefined) {
          e.data.draw = memoizeOne(oldWrapDraw(e, e.data.draw))
        }
      }
    }

    const wrapDraw = (e: GridElement): GridElement["draw"] => {
      let oldDraw = e.draw.bind(e)
      return options => {
        e.clear()
        oldDraw(options)
      }
    }
    let elementsToMemoize = [
      cellElements,
      gridLineElements,
      regionElements,
      cageElements,
      extraRegionElements,
      lineElements,
      svgPathElements,
      underlayElements,
      overlayElements,
      backgroundImageElements,
      givenCornerMarkElements,
      digitElements,
      cornerMarkElements,
      centreMarkElements,
      colourElements,
      selectionElements,
      errorElements,
    ]
    for (let r of elementsToMemoize) {
      for (let e of r.current) {
        e.draw = memoizeOne(wrapDraw(e))
      }
    }

    const wrapDrawWaypoints =
      (
        e: PenWaypointGraphics,
        draw: NonNullable<PenWaypointGraphics["data"]>["draw"],
      ): NonNullable<PenWaypointGraphics["data"]>["draw"] =>
      options => {
        // TODO instanceof not necessary in the future
        if (e instanceof Graphics) {
          e.clear()
        }
        draw(options)
      }
    for (let e of penCurrentWaypointsElements.current) {
      if (e.data?.draw !== undefined) {
        e.data.draw = memoizeOne(wrapDrawWaypoints(e, e.data.draw))
      }
    }

    if (onFinishRender) {
      onFinishRender()
    }

    return () => {
      if (allElement.current !== undefined) {
        allElement.current.destroy(true)
      }

      allElement.current = undefined
      gridElement.current = undefined
      cellsElement.current = undefined
      cellElements.current = []
      gridLineElements.current = []
      regionElements.current = []
      cageElements.current = []
      lineElements.current = []
      svgPathElements.current = []
      extraRegionElements.current = []
      underlayElements.current = []
      overlayElements.current = []
      fogElements.current = []
      givenCornerMarkElements.current = []
      digitElements.current = []
      centreMarkElements.current = []
      cornerMarkElements.current = []
      colourElements.current = []
      selectionElements.current = []
      errorElements.current = []
      penCurrentWaypointsElements.current = []
      penHitareaElements.current = []
      penLineElements.current = []
      backgroundImageElements.current = []

      document.removeEventListener("pointercancel", onPointerUp)
      document.removeEventListener("pointerup", onPointerUp)
    }
  }, [
    app,
    game.data,
    cellSize,
    regions,
    cages,
    extraRegions,
    onPenMove,
    updateGame,
    onFinishRender,
    onPointerUp,
    fogDisplayOptions.enableDropShadow,
  ])

  useEffect(() => {
    if (app === undefined) {
      return
    }

    let themeColours = getThemeColours(ref.current!)
    let cornerMarks = new Map<number, CornerMarksElement>()
    let centreMarks = new Map<number, CentreMarksElement>()

    for (let e of cornerMarkElements.current) {
      let digits = game.cornerMarks.get(e.k)
      e.setAllVisible(false)
      if (digits !== undefined) {
        for (let [i, d] of [...digits].sort().entries()) {
          let n = i
          if (digits.size > 8 && n > 4) {
            n++
          }
          e.fill = themeColours.smallDigitColor
          e.setValue(n, d)
          e.setVisible(n, true)
        }
        cornerMarks.set(e.k, e)
      }
    }

    for (let e of centreMarkElements.current) {
      let digits = game.centreMarks.get(e.k)
      if (digits !== undefined) {
        e.value = [...digits].sort().join("")
        e.fill = themeColours.smallDigitColor
        e.visible = true
        centreMarks.set(e.k, e)
      } else {
        e.visible = false
      }
    }

    for (let e of digitElements.current) {
      let digit = game.digits.get(e.k)
      if (digit !== undefined) {
        let [x, y] = ktoxy(e.k)
        if (digit.given && !digit.discovered && hasFog(game.fogRaster, x, y)) {
          e.visible = false
        } else {
          e.value = digit.digit
          e.fill = digit.given
            ? themeColours.foregroundColor
            : themeColours.digitColor
          e.visible = true

          let com = cornerMarks.get(e.k)
          if (com !== undefined) {
            com.setAllVisible(false)
          }

          let cem = centreMarks.get(e.k)
          if (cem !== undefined) {
            cem.visible = false
          }
        }
      } else {
        e.visible = false
      }
    }

    let colours = []
    if (colourPalette !== "custom" || customColours.length === 0) {
      let computedStyle = getComputedStyle(ref.current!)
      let nColours = +computedStyle.getPropertyValue("--colors")
      for (let i = 0; i < nColours; ++i) {
        colours[i] = computedStyle.getPropertyValue(`--color-${i + 1}`)
      }
    } else {
      colours = customColours
    }
    for (let e of colourElements.current) {
      let colour = game.colours.get(e.k)
      if (colour !== undefined) {
        let palCol = colours[colour.colour - 1]
        if (palCol === undefined) {
          palCol = colours[1] || colours[0]
        }
        let colourNumber = getRGBColor(palCol)
        e.colour = colourNumber
        e.visible = true
      } else {
        e.visible = false
      }
    }

    for (let pl of penLineElements.current) {
      pl.visible = game.penLines.has(pl.data!.k!)
    }

    for (let e of errorElements.current) {
      e.visible =
        game.errors.type === "wrongsolution" && game.errors.errors.has(e.k)
    }
  }, [
    app,
    colourPalette,
    customColours,
    game.centreMarks,
    game.colours,
    game.cornerMarks,
    game.digits,
    game.errors,
    game.fogRaster,
    game.penLines,
  ])

  useEffect(() => {
    // reset cell size on next draw
    cellSizeFactor.current = -1
  }, [maxWidth, maxHeight, portrait, zoom, game.data])

  useEffect(() => {
    if (app === undefined) {
      return
    }

    if (cellSizeFactor.current === -1) {
      cellSizeFactor.current = zoom + ZOOM_DELTA
    }
    let cs = Math.floor(cellSize * cellSizeFactor.current)
    let allBounds: Bounds
    let gridBounds: Bounds

    allElement.current!.x = allElement.current!.y = 0

    let themeColours = getThemeColours(ref.current!)

    // optimised font sizes for different screens
    let fontSizeCornerMarks =
      window.devicePixelRatio >= 2
        ? FONT_SIZE_CORNER_MARKS_HIGH_DPI
        : FONT_SIZE_CORNER_MARKS_LOW_DPI
    let fontSizeCentreMarks =
      window.devicePixelRatio >= 2
        ? FONT_SIZE_CENTRE_MARKS_HIGH_DPI
        : FONT_SIZE_CENTRE_MARKS_LOW_DPI

    // scale fonts
    let fontSizeDigits = FONT_SIZE_DIGITS * fontSizeFactorDigits
    fontSizeCornerMarks *= fontSizeFactorCornerMarks
    fontSizeCentreMarks *= fontSizeFactorCentreMarks

    for (let i = 0; i < 10; ++i) {
      // change font size of digits
      for (let e of digitElements.current) {
        e.fontSize = Math.round(fontSizeDigits * cellSizeFactor.current)
      }

      // change font size of corner marks
      for (let e of cornerMarkElements.current) {
        e.fontSize = Math.round(fontSizeCornerMarks * cellSizeFactor.current)
      }

      // change font size of centre marks
      for (let e of centreMarkElements.current) {
        e.fontSize = Math.round(fontSizeCentreMarks * cellSizeFactor.current)
      }

      // change font size and colour of given corner marks
      for (let e of givenCornerMarkElements.current) {
        e.fontSize = Math.round(fontSizeCornerMarks * cellSizeFactor.current)
        e.fill = themeColours.foregroundColor
      }

      // TODO remove
      let oldElementsToRedraw = [
        fogElements,
        penLineElements,
        penHitareaElements,
      ]
      for (let r of oldElementsToRedraw) {
        for (let e of r.current) {
          e.data?.draw({
            cellSize: cs,
            zoomFactor: cellSizeFactor.current,
            currentDigits: game.digits,
            currentFogLights: game.fogLights,
            currentFogRaster: game.fogRaster,
            themeColours,
          })
        }
      }
      let elementsToRedraw: MutableRefObject<GridElement[]>[] = [
        cellElements,
        gridLineElements,
        regionElements,
        cageElements,
        extraRegionElements,
        lineElements,
        svgPathElements,
        underlayElements,
        overlayElements,
        backgroundImageElements,
        givenCornerMarkElements,
        digitElements,
        cornerMarkElements,
        centreMarkElements,
        colourElements,
        selectionElements,
        errorElements,
      ]
      let gridOffset = { x: gridElement.current!.x, y: gridElement.current!.y }
      for (let r of elementsToRedraw) {
        for (let e of r.current) {
          e.draw({
            cellSize: cs,
            zoomFactor: cellSizeFactor.current,
            unitSize: (cs / cellSize) * SCALE_FACTOR,
            currentDigits: game.digits,
            currentFogLights: game.fogLights,
            currentFogRaster: game.fogRaster,
            themeColours,
            gridOffset,
          })
        }
      }

      for (let e of penCurrentWaypointsElements.current) {
        e.data?.draw({
          cellSize: cs,
          penCurrentWaypoints: penCurrentWaypoints.current,
        })
      }

      allBounds = allElement.current!.getBounds()
      gridBounds = gridElement.current!.getBounds()

      // Align bounds to pixels. This makes sure the grid is always sharp
      // and lines do not sit between pixels.
      let gx1 = gridBounds.x
      let gy1 = gridBounds.y
      let mx1 = gx1 - allBounds.x
      let my1 = gy1 - allBounds.y
      let gx2 = gx1 + gridBounds.width
      let gy2 = gy1 + gridBounds.height
      let ax2 = allBounds.x + allBounds.width
      let ay2 = allBounds.y + allBounds.height
      let mx2 = ax2 - gx2
      let my2 = ay2 - gy2
      let ax2b = gx2 + Math.ceil(mx2)
      let ay2b = gy2 + Math.ceil(my2)
      allBounds.x = gx1 - Math.ceil(mx1)
      allBounds.y = gy1 - Math.ceil(my1)
      allBounds.width = ax2b - allBounds.x
      allBounds.height = ay2b - allBounds.y

      if (allBounds.width <= maxWidth && allBounds.height <= maxHeight) {
        break
      }

      // leave 5 pixels of leeway for rounding errors
      let sx = (maxWidth - 5) / allBounds.width
      let sy = (maxHeight - 5) / allBounds.height
      cellSizeFactor.current = Math.min(sx, sy) * (zoom + ZOOM_DELTA)
      cs = Math.floor(cellSize * cellSizeFactor.current)
    }

    let marginTop = gridBounds!.y - allBounds!.y
    let marginBottom =
      allBounds!.y + allBounds!.height - (gridBounds!.y + gridBounds!.height)
    let marginLeft = gridBounds!.x - allBounds!.x
    let marginRight =
      allBounds!.x + allBounds!.width - (gridBounds!.x + gridBounds!.width)
    let additionalMarginX = 0
    let additionalMarginY = 0
    if (portrait) {
      additionalMarginX = Math.abs(marginLeft - marginRight)
    } else {
      additionalMarginY = Math.abs(marginTop - marginBottom)
    }

    let w = allBounds!.width
    let h = allBounds!.height

    app.renderer.resize(w, h)
    allElement.current!.x = -allBounds!.x
    allElement.current!.y = -allBounds!.y

    if (marginTop > marginBottom) {
      ref.current!.style.marginTop = "0"
      ref.current!.style.marginBottom = `${additionalMarginY}px`
    } else {
      ref.current!.style.marginTop = `${additionalMarginY}px`
      ref.current!.style.marginBottom = "0"
    }
    if (marginLeft > marginRight) {
      ref.current!.style.marginLeft = "0"
      ref.current!.style.marginRight = `${additionalMarginX}px`
    } else {
      ref.current!.style.marginLeft = `${additionalMarginX}px`
      ref.current!.style.marginRight = "0"
    }
  }, [
    app,
    cellSize,
    maxWidth,
    maxHeight,
    portrait,
    theme,
    zoom,
    fontSizeFactorDigits,
    fontSizeFactorCentreMarks,
    fontSizeFactorCornerMarks,
    game.data,
    game.mode,
    game.digits,
    game.colours,
    game.fogLights,
    game.fogRaster,
  ])

  // register keyboard handlers
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown)

    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [onKeyDown])

  useEffect(() => {
    if (app === undefined) {
      return
    }

    let themeColours = getThemeColours(ref.current!)

    // change background colour
    backgroundElement.current!.clear()
    drawBackground(
      backgroundElement.current!,
      app.renderer.width,
      app.renderer.height,
      themeColours,
    )
  }, [
    app,
    theme,
    selectionColour,
    maxWidth,
    maxHeight,
    portrait,
    game.data,
    game.mode,
  ])

  // Create a ref for the highlight container
  const highlightContainerRef = useRef<Container | null>(null)

  useEffect(() => {
    // Function to get or create the highlight container
    const getHighlightContainer = (): Container | null => {
      // If we already have a reference, use it
      if (highlightContainerRef.current) {
        // Clear any existing highlights
        highlightContainerRef.current.removeChildren()
        return highlightContainerRef.current
      }

      // Check if we have the grid element
      if (!gridElement.current) {
        console.log(
          "Grid element is not available for highlight container, waiting until next render cycle",
        )
        return null
      }

      // Otherwise create a new container
      const container = new Container()
      container.zIndex = 1000 // Very high zIndex
      container.sortableChildren = true // Enable z-index sorting
      gridElement.current.addChild(container)
      highlightContainerRef.current = container
      console.log("Created new custom highlights container")
      return container
    }

    // Get the container
    const container = getHighlightContainer()

    // If we don't have a container, skip highlighting for this render
    if (!container) {
      console.log("Skipping highlight rendering - no container available")
      return
    }

    // Constants for highlighting
    const SPECIAL_ALPHA = 0.7 // Alpha value for special highlights
    const ROW_COL_ALPHA = 0.15 // Same row or column
    const BLUE_COLOR = 0x00ccff // Blue for 2 unhighlighted cells
    const RED_COLOR = 0xff0000 // Red for 1 unhighlighted cell

    // Clear the container
    container.removeChildren()

    // First, clear all selection highlights and reset alpha
    selectionElements.current.forEach(s => {
      s.visible = false
      s.graphics.alpha = 0.5 // Reset to default alpha
    })

    // Set highlights for selected cells
    selectionElements.current.forEach(s => {
      if (game.selection.has(s.k)) {
        s.visible = true
      }
    })

    // Track cells with special highlighting and their priority
    // Higher number means higher priority (red > blue > yellow)
    const highlightedCells = new Map<
      number,
      { color: number; priority: number }
    >()

    // Helper function to add or update highlighted cell based on priority
    const addHighlightedCell = (
      cellK: number,
      color: number,
      priority: number,
    ) => {
      const existing = highlightedCells.get(cellK)
      if (!existing || priority > existing.priority) {
        console.log(
          `Setting highlight for cell ${cellK} to color ${color.toString(16)} with priority ${priority}`,
        )
        highlightedCells.set(cellK, { color, priority })
      } else {
        console.log(
          `Not updating cell ${cellK} - already has color ${existing.color.toString(16)} with priority ${existing.priority} vs new priority ${priority}`,
        )
      }
    }

    // If we have a selection with only one cell, highlight related cells
    if (game.selection.size === 1) {
      const selectedCellK = [...game.selection][0]
      const selectedDigit = game.digits.get(selectedCellK)
      const [selectedX, selectedY] = ktoxy(selectedCellK)

      // Only highlight legal placement cells if the selected cell has a digit
      if (selectedDigit) {
        // Helper function to check if a cell can legally contain the selected digit
        const canCellContainDigit = (cellK: number): boolean => {
          // If cell already has a digit, it can't contain another
          if (game.digits.get(cellK)) {
            return false
          }

          const [cx, cy] = ktoxy(cellK)

          // Check if the cell is in the same row, column, or box as the selected cell
          const inSameRow = cy === selectedY
          const inSameCol = cx === selectedX
          const inSameBox =
            Math.floor(cx / 3) === Math.floor(selectedX / 3) &&
            Math.floor(cy / 3) === Math.floor(selectedY / 3)

          if (inSameRow || inSameCol || inSameBox) {
            return false
          }

          // Check if cell is in same row/column as another instance of this digit
          for (const [k, digit] of game.digits.entries()) {
            if (k !== selectedCellK && digit.digit === selectedDigit.digit) {
              const [dx, dy] = ktoxy(k)
              if (cy === dy || cx === dx) {
                return false
              }

              // Check if in same box as another instance of this digit
              if (
                Math.floor(cx / 3) === Math.floor(dx / 3) &&
                Math.floor(cy / 3) === Math.floor(dy / 3)
              ) {
                return false
              }
            }
          }

          // If passed all constraints, the cell can contain this digit
          return true
        }

        // Highlight all cells that CAN legally contain the selected digit
        selectionElements.current.forEach(element => {
          // Skip the selected cell - it's already highlighted
          if (element.k === selectedCellK) return

          if (canCellContainDigit(element.k)) {
            element.visible = true
            element.graphics.alpha = ROW_COL_ALPHA
          }
        })
      }

      // We still need to collect the same digit cells for the special highlighting below
      if (selectedDigit) {
        // Find all cells with the same digit (but don't highlight them)
        const sameDigitCells: { k: number; x: number; y: number }[] = []

        game.digits.forEach((digit, k) => {
          if (digit.digit === selectedDigit.digit) {
            const [x, y] = ktoxy(k)
            sameDigitCells.push({ k, x, y })
            // We no longer highlight other cells with the same digit
          }
        })
      }

      // Special highlighting for 3x3 boxes with only two unhighlighted squares
      if (selectedDigit) {
        console.log(
          `Starting special highlighting check for digit: ${selectedDigit.digit}`,
        )

        // We already have a container from getHighlightContainer

        // For each 3x3 box, check if it has only two unhighlighted cells
        for (let boxRow = 0; boxRow < 3; boxRow++) {
          for (let boxCol = 0; boxCol < 3; boxCol++) {
            console.log(`Checking box at [${boxRow}, ${boxCol}]`)
            const potentialCells: number[] = [] // Cells that can legally contain the digit
            const cornerMarkCells: number[] = [] // Cells with corner marks matching the selected digit
            const allCellsInBox: number[] = []

            // Check each cell in this 3x3 box
            for (let cellY = boxRow * 3; cellY < boxRow * 3 + 3; cellY++) {
              for (let cellX = boxCol * 3; cellX < boxCol * 3 + 3; cellX++) {
                const cellK = xytok(cellX, cellY)
                allCellsInBox.push(cellK)
                const element = selectionElements.current.find(
                  el => el.k === cellK,
                )

                console.log(
                  `Cell [${cellX}, ${cellY}], k=${cellK}: visible=${element?.visible}, hasDigit=${Boolean(game.digits.get(cellK))}`,
                )

                // In our inverted approach, highlighted cells are those that CAN contain the digit
                // For the special highlighting, we need to identify cells that:
                // 1. Are empty (no digit)
                // 2. CAN contain the selected digit (should be highlighted)
                const canContainDigit =
                  element && element.graphics && element.graphics.visible
                const isEmpty = !game.digits.get(cellK)

                // If cell CAN contain the digit and is empty, add to our list of potential cells
                if (element && canContainDigit && isEmpty) {
                  potentialCells.push(cellK)
                  console.log(
                    `  Added to potential cells (graphics.visible = ${element.graphics.visible})`,
                  )
                }

                // Check if this cell has corner marks matching the selected digit
                const cornerMarks = game.cornerMarks.get(cellK)
                if (cornerMarks) {
                  console.log(
                    `Cell ${cellK} has corner marks: ${Array.from(cornerMarks)}, checking for: ${selectedDigit.digit}, type: ${typeof selectedDigit.digit}`,
                  )
                  if (cornerMarks.has(selectedDigit.digit) && isEmpty) {
                    cornerMarkCells.push(cellK)
                    console.log(
                      `  Cell has corner mark matching ${selectedDigit.digit}`,
                    )
                  }
                }
              }
            }

            // Check if this 3x3 box already contains the selected digit
            let boxContainsSelectedDigit = false
            game.digits.forEach((digit, k) => {
              if (digit.digit === selectedDigit.digit) {
                const [x, y] = ktoxy(k)
                if (
                  Math.floor(x / 3) === boxCol &&
                  Math.floor(y / 3) === boxRow
                ) {
                  boxContainsSelectedDigit = true
                  console.log(
                    `Box already contains the selected digit ${selectedDigit.digit} at [${x}, ${y}]`,
                  )
                }
              }
            })

            console.log(
              `Box [${boxRow}, ${boxCol}]: potential cells = ${potentialCells.length}, corner mark cells = ${cornerMarkCells.length}, contains digit=${boxContainsSelectedDigit}`,
            )

            // Handle both cases: 1 or 2 potential cells (if box doesn't have the digit)
            if (
              !boxContainsSelectedDigit &&
              (potentialCells.length === 1 || potentialCells.length === 2)
            ) {
              // Choose color based on count - red for 1, blue for 2
              const highlightColor =
                potentialCells.length === 1 ? RED_COLOR : BLUE_COLOR
              const countLabel = potentialCells.length === 1 ? "one" : "two"

              console.log(
                `Found box with exactly ${countLabel} potential cells and no digit ${selectedDigit.digit}`,
              )

              // Register these cells with priority 2 for red, 1 for blue
              potentialCells.forEach(cellK => {
                const [x, y] = ktoxy(cellK)
                console.log(
                  `Registering special cell at [${x}, ${y}], k=${cellK}, color=${highlightColor.toString(16)}`,
                )

                // Set priorities: red (4) > blue (3) > yellow (0)
                const priority = highlightColor === RED_COLOR ? 4 : 3
                addHighlightedCell(cellK, highlightColor, priority)
              })
            }

            // Check if exactly two cells in this box have corner marks matching the selected digit
            // and the box doesn't already contain the digit
            if (!boxContainsSelectedDigit && cornerMarkCells.length === 2) {
              console.log(
                `Found box with exactly two cells containing corner mark ${selectedDigit.digit}`,
              )

              // First dump all the corner mark info for debugging
              console.log("All corner marks in this box:")
              cornerMarkCells.forEach(cellK => {
                const cornerMarks = game.cornerMarks.get(cellK)
                console.log(
                  `Cell ${cellK}: corner marks = ${cornerMarks ? Array.from(cornerMarks) : "none"}`,
                )
              })

              // First, check if these cells are valid placements according to Sudoku rules
              // by checking if they would violate row, column, or box constraints
              const validCornerMarkCells = cornerMarkCells.filter(cellK => {
                const [cx, cy] = ktoxy(cellK)
                let isValid = true

                // Debug info
                console.log(
                  `Checking validity of cell ${cellK} at [${cx}, ${cy}]`,
                )

                // Check if this cell would violate Sudoku rules
                // by being in the same row, column, or box as an existing instance of this digit
                game.digits.forEach((digit, k) => {
                  if (digit.digit === selectedDigit.digit) {
                    const [dx, dy] = ktoxy(k)

                    // Check if in same row, column, or box
                    const inSameRow = cy === dy
                    const inSameCol = cx === dx
                    const inSameBox =
                      Math.floor(cx / 3) === Math.floor(dx / 3) &&
                      Math.floor(cy / 3) === Math.floor(dy / 3)

                    if (inSameRow || inSameCol || inSameBox) {
                      console.log(
                        `  Invalid - conflicts with digit at [${dx}, ${dy}]`,
                      )
                      isValid = false
                    }
                  }
                })

                // Verify again that this cell actually has the corner mark
                const cornerMarks = game.cornerMarks.get(cellK)
                if (!cornerMarks || !cornerMarks.has(selectedDigit.digit)) {
                  console.log(
                    `  Invalid - cell no longer has corner mark ${selectedDigit.digit}`,
                  )
                  isValid = false
                }

                console.log(
                  `  Cell ${cellK} is ${isValid ? "valid" : "invalid"} for corner mark ${selectedDigit.digit}`,
                )
                return isValid
              })

              console.log(
                `Found ${cornerMarkCells.length} corner mark cells, ${validCornerMarkCells.length} are valid according to Sudoku rules`,
              )

              // Only if both cells are valid according to Sudoku rules, highlight them
              if (validCornerMarkCells.length === 2) {
                // Highlight cells directly without using priority system
                validCornerMarkCells.forEach(cellK => {
                  const [x, y] = ktoxy(cellK)
                  console.log(
                    `Highlighting corner mark cell at [${x}, ${y}], k=${cellK} directly with blue`,
                  )

                  // Instead of disabling yellow highlights, just add to the priority system
                  // This ensures the highlight actually appears
                  const priority = 3 // Blue priority
                  console.log(
                    `Adding blue highlight for corner mark cell ${cellK} with priority ${priority}`,
                  )
                  addHighlightedCell(cellK, BLUE_COLOR, priority)

                  // We'll add the highlight through the priority system
                  // No need for a direct approach since we refactored the highlighting system
                })
              }
            }

            // NEW FEATURE: Check for naked pairs in center markings that include the selected digit
            // Only proceed if we have a selected digit
            if (selectedDigit) {
              // Get all cells with center marks in this box
              const centreMarkCells: number[] = []
              for (let cellY = boxRow * 3; cellY < boxRow * 3 + 3; cellY++) {
                for (let cellX = boxCol * 3; cellX < boxCol * 3 + 3; cellX++) {
                  const cellK = xytok(cellX, cellY)
                  // Check if empty cell with center marks
                  const centerMarks = game.centreMarks.get(cellK)
                  if (!game.digits.get(cellK) && centerMarks) {
                    // Only include cells that have the selected digit as a center mark
                    if (centerMarks.has(selectedDigit.digit)) {
                      centreMarkCells.push(cellK)
                    }
                  }
                }
              }

              // Now check for naked pairs (cells with exactly the same 2 center marks)
              if (centreMarkCells.length >= 2) {
                console.log(
                  `Checking ${centreMarkCells.length} cells with center marks containing ${selectedDigit.digit}`,
                )

                // Group cells by their center mark content (as a sorted string)
                const cellsByCentreMarks = new Map<string, number[]>()
                centreMarkCells.forEach(cellK => {
                  const marks = game.centreMarks.get(cellK)
                  if (marks && marks.size === 2) {
                    // Only interested in cells with exactly 2 center marks
                    const marksArray = Array.from(marks).sort()
                    const marksKey = marksArray.join(",")

                    if (!cellsByCentreMarks.has(marksKey)) {
                      cellsByCentreMarks.set(marksKey, [])
                    }
                    cellsByCentreMarks.get(marksKey)!.push(cellK)
                    console.log(
                      `Cell ${cellK} has center marks: ${marksArray}, key: ${marksKey}`,
                    )
                  }
                })

                // Check each group for pairs
                cellsByCentreMarks.forEach((cells, marksKey) => {
                  // Only highlight if it's a pair (exactly 2 cells with the same center marks)
                  if (cells.length === 2) {
                    // Convert the key back to an array to check if it contains the selected digit
                    const markDigits = marksKey.split(",").map(d => {
                      // Handle both string and number conversions
                      return isNaN(Number(d)) ? d : Number(d)
                    })

                    // Verify again that the naked pair contains the selected digit
                    if (markDigits.includes(selectedDigit.digit)) {
                      console.log(
                        `Found naked pair with digits [${marksKey}] including selected digit ${selectedDigit.digit} in cells: ${cells}`,
                      )

                      // Highlight these cells with blue
                      cells.forEach(cellK => {
                        const [x, y] = ktoxy(cellK)
                        console.log(
                          `Highlighting naked pair cell at [${x}, ${y}], k=${cellK} with blue`,
                        )

                        // Add to highlight system with same priority as corner pairs
                        const priority = 3 // Blue priority
                        addHighlightedCell(cellK, BLUE_COLOR, priority)
                      })
                    } else {
                      console.log(
                        `Ignoring naked pair [${marksKey}] as it doesn't include selected digit ${selectedDigit.digit}`,
                      )
                    }
                  }
                })
              }
            }
          }
        }
      }
    }

    // Now apply all the special highlights based on priority
    console.log(
      `Applying ${highlightedCells.size} special highlights for potential cells`,
    )
    if (highlightedCells.size > 0) {
      // Set this container to sort by zIndex
      container.sortableChildren = true

      // Process each highlighted cell
      highlightedCells.forEach((highlight, cellK) => {
        const [x, y] = ktoxy(cellK)
        console.log(
          `Applying highlight to cell at [${x}, ${y}], k=${cellK}, color=${highlight.color.toString(16)}, priority=${highlight.priority}`,
        )

        try {
          // Create graphics for the highlight
          const specialHighlight = new Graphics()
          specialHighlight.beginFill(highlight.color, SPECIAL_ALPHA)
          specialHighlight.drawRect(
            0,
            0,
            cellSize * cellSizeFactor.current - 1,
            cellSize * cellSizeFactor.current - 1,
          )
          specialHighlight.endFill()

          // Set the zIndex based on priority
          specialHighlight.zIndex = highlight.priority + 5

          // Position it using coordinates
          specialHighlight.x = x * cellSize * cellSizeFactor.current
          specialHighlight.y = y * cellSize * cellSizeFactor.current

          // Add to container
          container.addChild(specialHighlight)

          console.log(
            `  Added direct highlight at [${x}, ${y}], k=${cellK}, color=${highlight.color.toString(16)}, zIndex=${specialHighlight.zIndex}`,
          )

          // If this is a blue highlight for a corner mark, make it more visible for debugging
          if (highlight.color === BLUE_COLOR && highlight.priority === 3) {
            console.log(
              `  This is a blue corner mark highlight! Making it more visible.`,
            )
            specialHighlight.alpha = 0.8 // Make it more visible
          }
        } catch (e) {
          console.error(`  Error adding special highlight: ${e}`)
        }
      })

      // Force sorting by zIndex
      container.sortChildren()
    }

    // Trigger render
    renderNow()
  }, [game.selection, game.digits, game.cornerMarks, renderNow])

  useEffect(() => {
    if (app === undefined) {
      return
    }

    renderNow()

    if ("_SUDOCLE_IS_TEST" in window) {
      let promises = []
      for (let bg of backgroundImageElements.current) {
        promises.push(bg.readyPromise)
      }
      for (let p of svgPathElements.current) {
        promises.push(p.readyPromise)
      }
      Promise.all(promises).then(() => {
        screenshotNow()
      })
    }
  }, [
    app,
    cellSize,
    game.data,
    game.digits,
    game.cornerMarks,
    game.centreMarks,
    game.colours,
    game.mode,
    game.penLines,
    game.errors,
    game.fogRaster,
    theme,
    colourPalette,
    selectionColour,
    customColours,
    zoom,
    fontSizeFactorDigits,
    fontSizeFactorCentreMarks,
    fontSizeFactorCornerMarks,
    maxWidth,
    maxHeight,
    portrait,
    renderNow,
    screenshotNow,
  ])

  return (
    <div
      ref={ref}
      className="flex"
      onClick={onBackgroundClick}
      onDoubleClick={onDoubleClick}
    ></div>
  )
}

export default Grid
