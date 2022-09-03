import GameContext from "./contexts/GameContext"
import SettingsContext from "./contexts/SettingsContext"
import { TYPE_DIGITS, TYPE_PENLINES, TYPE_SELECTION, ACTION_CLEAR,
  ACTION_SET, ACTION_PUSH, ACTION_REMOVE } from "./lib/Actions"
import { MODE_PEN } from "./lib/Modes"
import { ktoxy, xytok, pltok } from "./lib/utils"
import Color from "color"
import polygonClipping from "polygon-clipping"
import styles from "./Grid.scss"
import { useCallback, useContext, useEffect, useMemo, useRef } from "react"
import { flatten } from "lodash"

const SCALE_FACTOR = 1.2
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

let PIXI
if (typeof window !== "undefined") {
  PIXI = require("pixi.js-legacy")
}

function unionCells(cells) {
  let polys = cells.map(cell => {
    let y = cell[0]
    let x = cell[1]
    return [[
      [x + 0, y + 0],
      [x + 1, y + 0],
      [x + 1, y + 1],
      [x + 0, y + 1]
    ]]
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
        let sharedPoint = u[0].findIndex(pu => pu[0] === ph[0] && pu[1] === ph[1])
        if (sharedPoint >= 0) {
          // we found a shared point - merge hole into outer polygon
          u[0] = [
            ...u[0].slice(0, sharedPoint),
            ...hole.slice(spi), ...hole.slice(0, spi),
            ...u[0].slice(sharedPoint)
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

  return flatten(unions.map(u => u.map(u2 => flatten(u2))))
}

function hasCageValue(x, y, cages) {
  for (let cage of cages) {
    if (cage.topleft[0] === y && cage.topleft[1] === x &&
        cage.value !== undefined && cage.value !== "") {
      return true
    }
  }
  return false
}

function hasGivenCornerMarks(cell) {
  if (cell.pencilMarks === undefined) {
    return false
  }
  if (Array.isArray(cell.pencilMarks) && cell.pencilMarks.length === 0) {
    return false
  }
  return cell.pencilMarks !== ""
}

// shrink polygon inwards by distance `d`
function shrinkPolygon(points, d) {
  let result = []

  for (let i = 0; i < points.length; i += 2) {
    let p1x = points[(i - 2 + points.length) % points.length]
    let p1y = points[(i - 1 + points.length) % points.length]
    let p2x = points[(i + 0) % points.length]
    let p2y = points[(i + 1) % points.length]
    let p3x = points[(i + 2) % points.length]
    let p3y = points[(i + 3) % points.length]

    let ax = p2x - p1x
    let ay = p2y - p1y
    let anx = -ay
    let any = ax
    let al = Math.sqrt(anx * anx + any * any)
    anx /= al
    any /= al

    let bx = p3x - p2x
    let by = p3y - p2y
    let bnx = -by
    let bny = bx
    let bl = Math.sqrt(bnx * bnx + bny * bny)
    bnx /= bl
    bny /= bl

    let nx = anx + bnx
    let ny = any + bny

    result.push(p2x + nx * d)
    result.push(p2y + ny * d)
  }

  return result
}

// dispose edges of given polygon by distance `d` whenever they lie on an
// edge of one of the other given polygons
function disposePolygon(points, otherPolygons, d) {
  let result = [...points]
  for (let i = 0; i < points.length; i += 2) {
    let p1x = points[i]
    let p1y = points[i + 1]
    let p2x = points[(i + 2) % points.length]
    let p2y = points[(i + 3) % points.length]

    let sx = p1y < p2y ? -1 : 1
    let sy = p1x > p2x ? -1 : 1

    for (let otherPoints of otherPolygons) {
      let disposed = false
      for (let j = 0; j < otherPoints.length; j += 2) {
        let o1x = otherPoints[j]
        let o1y = otherPoints[j + 1]
        let o2x = otherPoints[(j + 2) % otherPoints.length]
        let o2y = otherPoints[(j + 3) % otherPoints.length]

        if (o1x > o2x) {
          let x = o2x
          o2x = o1x
          o1x = x
        }
        if (o1y > o2y) {
          let y = o2y
          o2y = o1y
          o1y = y
        }

        // simplified because we know edges are always vertical or horizontal
        if (o1x === o2x && p1x === o1x && p2x === o2x &&
            ((o1y <= p1y && o2y >= p1y) || (o1y <= p2y && o2y >= p2y))) {
          result[i] = p1x + d * sx
          result[(i + 2) % points.length] = p2x + d * sx
          disposed = true
          break
        }
        if (o1y === o2y && p1y === o1y && p2y === o2y &&
            ((o1x <= p1x && o2x >= p1x) || (o1x <= p2x && o2x >= p2x))) {
          result[i + 1] = p1y + d * sy
          result[(i + 3) % points.length] = p2y + d * sy
          disposed = true
          break
        }
      }
      if (disposed) {
        break
      }
    }
  }
  return result
}

// based on https://codepen.io/unrealnl/pen/aYaxBW by Erik
// published under the MIT license
function drawDashedPolygon(points, dash, gap, graphics) {
  let dashLeft = 0
  let gapLeft = 0

  for (let i = 0; i < points.length; i += 2) {
    let p1x = points[i]
    let p1y = points[i + 1]
    let p2x = points[(i + 2) % points.length]
    let p2y = points[(i + 3) % points.length]

    let dx = p2x - p1x
    let dy = p2y - p1y

    let len = Math.sqrt(dx * dx + dy * dy)
    let normalx = dx / len
    let normaly = dy / len
    let progressOnLine = 0

    graphics.moveTo(p1x + gapLeft * normalx, p1y + gapLeft * normaly)

    while (progressOnLine <= len) {
      progressOnLine += gapLeft

      if (dashLeft > 0) {
        progressOnLine += dashLeft
      } else {
        progressOnLine += dash
      }

      if (progressOnLine > len) {
        dashLeft = progressOnLine - len
        progressOnLine = len
      } else {
        dashLeft = 0
      }

      graphics.lineTo(p1x + progressOnLine * normalx, p1y + progressOnLine * normaly)

      progressOnLine += gap

      if (progressOnLine > len && dashLeft === 0) {
        gapLeft = progressOnLine - len
      } else {
        gapLeft = 0
        graphics.moveTo(p1x + progressOnLine * normalx, p1y + progressOnLine * normaly)
      }
    }
  }
}

function isGrey(nColour) {
  let r = (nColour >> 16) & 0xff
  let g = (nColour >> 8) & 0xff
  let b = nColour & 0xff
  return r === g && r === b
}

// PIXI makes lines with round cap slightly longer. This function shortens them.
function shortenLine(points, delta = 3) {
  if (points.length <= 2) {
    return points
  }

  let firstPointX = points[0]
  let firstPointY = points[1]
  let secondPointX = points[2]
  let secondPointY = points[3]
  let lastPointX = points[points.length - 2]
  let lastPointY = points[points.length - 1]
  let secondToLastX = points[points.length - 4]
  let secondToLastY = points[points.length - 3]

  if (firstPointX === lastPointX && firstPointY === lastPointY) {
    // do not shorten closed loops
    return points
  }

  let dx = secondPointX - firstPointX
  let dy = secondPointY - firstPointY
  let l = Math.sqrt(dx * dx + dy * dy)
  if (l > delta * 2.5) {
    dx /= l
    dy /= l
    firstPointX = firstPointX + dx * delta
    firstPointY = firstPointY + dy * delta
  }

  dx = secondToLastX - lastPointX
  dy = secondToLastY - lastPointY
  l = Math.sqrt(dx * dx + dy * dy)
  if (l > delta * 2.5) {
    dx /= l
    dy /= l
    lastPointX = lastPointX + dx * delta
    lastPointY = lastPointY + dy * delta
  }

  return [firstPointX, firstPointY, ...points.slice(2, points.length - 2),
    lastPointX, lastPointY]
}

function euclidianBresenhamInterpolate(x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0)
  let sx = x0 < x1 ? 1 : -1
  let dy = -Math.abs(y1 - y0)
  let sy = y0 < y1 ? 1 : -1
  let err = dx + dy

  let result = []
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

function filterDuplicatePoints(points) {
  let i = 3
  while (i < points.length) {
    let prevx = points[i - 3]
    let prevy = points[i - 2]
    let currx = points[i - 1]
    let curry = points[i - 0]
    if (prevx === currx && prevy === curry) {
      points = [...points.slice(0, i - 1), ...points.slice(i + 1)]
    } else {
      i += 2
    }
  }
  return points
}

function makeCornerMarks(x, y, cellSize, fontSize, leaveRoom, n = 11, fontWeight = "normal") {
  let result = []

  for (let i = 0; i < n; ++i) {
    let text = new PIXI.Text("", {
      fontFamily: "Roboto, sans-serif",
      fontSize,
      fontWeight
    })

    text.data = {
      draw: function (cellSize) {
        let cx = x * cellSize + cellSize / 2
        let cy = y * cellSize + cellSize / 2 - 0.5
        let mx = cellSize / 3.2
        let my = cellSize / 3.4

        switch (i) {
          case 0:
            if (leaveRoom) {
              text.x = cx - mx / 3
              text.y = cy - my
            } else {
              text.x = cx - mx
              text.y = cy - my
            }
            break
          case 4:
            if (leaveRoom) {
              text.x = cx + mx / 3
              text.y = cy - my
            } else {
              text.x = cx
              text.y = cy - my
            }
            break
          case 1:
            text.x = cx + mx
            text.y = cy - my
            break
          case 6:
            text.x = cx - mx
            text.y = cy
            break
          case 7:
            text.x = cx + mx
            text.y = cy
            break
          case 2:
            text.x = cx - mx
            text.y = cy + my
            break
          case 5:
            text.x = cx
            text.y = cy + my
            break
          case 3:
            text.x = cx + mx
            text.y = cy + my
            break
          case 8:
            text.x = cx - mx / 3
            text.y = cy + my
            break
          case 9:
            text.x = cx + mx / 3
            text.y = cy + my
            break
        }
      }
    }

    text.anchor.set(0.5)
    text.scale.x = 0.5
    text.scale.y = 0.5

    result.push(text)
  }

  return result
}

function getRGBColor(colorString) {
  return Color(colorString.trim()).rgbNumber()
}

function getThemeColour(style, color) {
  return getRGBColor(style.getPropertyValue(color))
}

function getThemeColours(elem) {
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
      blue: selectionBlue
    }
  }
}

function drawBackground(graphics, width, height, themeColours) {
  graphics.hitArea = new PIXI.Rectangle(0, 0, width, height)
  graphics.beginFill(themeColours.backgroundColor)
  graphics.drawRect(0, 0, width, height)
  graphics.endFill()
}

function changeLineColour(graphicElements, colour) {
  for (let e of graphicElements) {
    let c = e.data?.borderColor || colour
    for (let i = 0; i < e.geometry.graphicsData.length; ++i) {
      e.geometry.graphicsData[i].lineStyle.color = c
    }
    e.geometry.invalidate()
  }
}

function cellToScreenCoords(cell, mx, my, cellSize) {
  return [cell[1] * cellSize + mx, cell[0] * cellSize + my]
}

function penWaypointsToKey(wp1, wp2, penCurrentDrawEdge) {
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

function drawOverlay(overlay, mx, my, zIndex) {
  let r = new PIXI.Graphics()
  r.zIndex = zIndex

  if (overlay.rotation !== undefined) {
    r.rotation = overlay.rotation
  }

  let text
  let fontSize = overlay.fontSize || 20
  if (overlay.text !== undefined) {
    fontSize *= SCALE_FACTOR
    if (overlay.fontSize < 14) {
      fontSize *= (1 / 0.75)
    }
    text = new PIXI.Text(overlay.text, {
      fontFamily: "Roboto, sans-serif",
      fontSize
    })
    if (overlay.fontColor) {
      text.style.fill = overlay.fontColor
    }
    text.anchor.set(0.5)
    if (overlay.fontSize < 14) {
      text.scale.x = 0.75
      text.scale.y = 0.75
    }
    r.addChild(text)
  }

  r.data = {
    draw: function (cellSize, zoomFactor) {
      let center = cellToScreenCoords(overlay.center, mx, my, cellSize)
      r.x = center[0]
      r.y = center[1]

      if (text !== undefined) {
        text.style.fontSize = Math.round(fontSize * zoomFactor)
      }

      if (overlay.backgroundColor !== undefined || overlay.borderColor !== undefined) {
        let nBackgroundColour
        if (overlay.backgroundColor !== undefined) {
          nBackgroundColour = getRGBColor(overlay.backgroundColor)
          r.beginFill(nBackgroundColour, isGrey(nBackgroundColour) ? 1 : 0.5)
        }
        if (overlay.borderColor !== undefined) {
          let nBorderColour = getRGBColor(overlay.borderColor)
          if (nBorderColour !== nBackgroundColour &&
              !(overlay.width === 1 && overlay.height === 1 && !overlay.rounded && isGrey(nBorderColour))) {
            r.lineStyle({
              width: 2,
              color: nBorderColour,
              alpha: isGrey(nBorderColour) ? 1 : 0.5,
              alignment: 0
            })
          }
        }
        let w = overlay.width * cellSize
        let h = overlay.height * cellSize
        if (overlay.rounded) {
          if (w === h) {
            r.drawEllipse(0, 0, w / 2, h / 2)
          } else {
            r.drawRoundedRect(-w / 2, -h / 2, w, h, Math.min(w, h) / 2 - 1)
          }
        } else {
          r.drawRect(-w / 2, -h / 2, w, h)
        }
        if (overlay.backgroundColor !== undefined) {
          r.endFill()
        }
      }
    }
  }

  return r
}

const Grid = ({ maxWidth, maxHeight, portrait, onFinishRender }) => {
  const ref = useRef()
  const app = useRef()
  const gridElement = useRef()
  const cellsElement = useRef()
  const allElement = useRef()
  const cellElements = useRef([])
  const regionElements = useRef([])
  const cageElements = useRef([])
  const cageLabelTextElements = useRef([])
  const cageLabelBackgroundElements = useRef([])
  const lineElements = useRef([])
  const extraRegionElements = useRef([])
  const underlayElements = useRef([])
  const overlayElements = useRef([])
  const backgroundElement = useRef()
  const givenCornerMarkElements = useRef([])
  const digitElements = useRef([])
  const centreMarkElements = useRef([])
  const cornerMarkElements = useRef([])
  const colourElements = useRef([])
  const selectionElements = useRef([])
  const errorElements = useRef([])
  const penCurrentWaypoints = useRef([])
  const penCurrentWaypointsAdd = useRef(true)
  const penCurrentWaypointsElements = useRef([])
  const penHitareaElements = useRef([])
  const penCurrentDrawEdge = useRef(false)
  const penLineElements = useRef([])

  const renderLoopStarted = useRef(0)
  const rendering = useRef(false)

  const game = useContext(GameContext.State)
  const updateGame = useContext(GameContext.Dispatch)
  const settings = useContext(SettingsContext.State)

  const currentMode = useRef(game.mode)

  const cellSize = game.data.cellSize * SCALE_FACTOR
  const cellSizeFactor = useRef(1)

  const regions = useMemo(() => flatten(game.data.regions.map(region => {
    return unionCells(region)
  })), [game.data])

  const cages = useMemo(() => flatten(game.data.cages
    .filter(cage => cage.cells?.length)
    .map(cage => {
      let unions = unionCells(cage.cells)
      return unions.map(union => {
        // find top-left cell
        let topleft = cage.cells[0]
        for (let cell of cage.cells) {
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
          topleft
        }
      })
    })), [game.data])

  const extraRegions = useMemo(() => {
    if (Array.isArray(game.data.extraRegions)) {
      return flatten(game.data.extraRegions
        .filter(r => r.cells?.length)
        .map(r => {
          let unions = unionCells(r.cells)
          return unions.map(union => {
            return {
              outline: union,
              backgroundColor: r.backgroundColor
            }
          })
        })
      )
    } else {
      return []
    }
  }, [game.data])

  const selectCell = useCallback((cell, evt, append = false) => {
    if (currentMode.current === MODE_PEN) {
      // do nothing in pen mode
      return
    }

    let action = append ? ACTION_PUSH : ACTION_SET
    let oe = evt?.data?.originalEvent
    if (oe?.metaKey || oe?.ctrlKey) {
      if (oe?.shiftKey) {
        action = ACTION_REMOVE
      } else {
        action = ACTION_PUSH
      }
    }

    updateGame({
      type: TYPE_SELECTION,
      action,
      k: cell.data.k
    })
  }, [updateGame])

  const onPenMove = useCallback((e, cellSize) => {
    if (e.target === null) {
      // pointer is not over the hit area
      return
    }
    if (e.data.buttons !== 1) {
      // let mouse button is not pressed
      return
    }

    let gridBounds = gridElement.current.getBounds()
    let x = e.data.global.x - gridBounds.x
    let y = e.data.global.y - gridBounds.y

    let fCellX = x / cellSize
    let fCellY = y / cellSize
    let cellX = Math.floor(fCellX)
    let cellY = Math.floor(fCellY)
    let cellDX = fCellX - cellX
    let cellDY = fCellY - cellY
    if (penCurrentWaypoints.current.length === 0) {
      // snap to cell edge or cell center
      if (cellDX >= 0.25 && cellDX <= 0.75 && cellDY >= 0.25 && cellDY <= 0.75) {
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
    } else if (penCurrentWaypoints.current[penCurrentWaypoints.current.length - 1] === k) {
      // nothing to do
      return
    } else {
      let pcw = penCurrentWaypoints.current
      let toAdd = []
      if (pcw.length > 0) {
        let fp = pcw[pcw.length - 1]
        let fpp = ktoxy(fp)
        let dx = Math.abs(cellX - fpp[0])
        let dy = Math.abs(cellY - fpp[1])
        if (dx + dy !== 1) {
          // cursor was moved diagonally or jumped to a distant cell
          // interpolate between the last cell and the new one
          let interpolated = euclidianBresenhamInterpolate(fpp[0], fpp[1], cellX, cellY)
          for (let ip of interpolated) {
            toAdd.push(xytok(ip[0], ip[1]))
          }
        }
      }
      toAdd.push(k)

      // check if we've moved backwards and, if so, how much
      let matched = 0
      for (let a = pcw.length - 2, b = 0; a >= 0, b < toAdd.length; --a, ++b) {
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

      // check if we are adding a pen line or removing it
      if (pcw.length > 1) {
        let firstKey = penWaypointsToKey(pcw[0], pcw[1], penCurrentDrawEdge.current)
        let visible = penLineElements.current.some(e => e.data.k === firstKey && e.visible)
        penCurrentWaypointsAdd.current = !visible
      }
    }

    // render waypoints
    penCurrentWaypointsElements.current.forEach(e => e.data.draw())
    renderNow()
  }, [renderNow])

  const onKeyDown = useCallback(e => {
    let digit = e.code.match("Digit([0-9])")
    if (digit) {
      let nd = +digit[1]
      updateGame({
        type: TYPE_DIGITS,
        action: ACTION_SET,
        digit: nd
      })
      e.preventDefault()
    }

    let numpad = e.code.match("Numpad([0-9])")
    if (numpad && +e.key === +numpad[1]) {
      let nd = +numpad[1]
      updateGame({
        type: TYPE_DIGITS,
        action: ACTION_SET,
        digit: nd
      })
      e.preventDefault()
    }

    if (e.key === "Backspace" || e.key === "Delete" || e.key === "Clear") {
      updateGame({
        type: TYPE_DIGITS,
        action: ACTION_REMOVE
      })
    }
  }, [updateGame])

  function onBackgroundClick(e) {
    e.stopPropagation()
  }

  function onDoubleClick(e) {
    if (game.selection.size === 0 || !e.altKey) {
      return
    }

    // get color of last cell clicked
    let last = [...game.selection].pop()
    let colour = game.colours.get(last)

    if (colour !== undefined) {
      // find all cells with the same colour
      let allCells = []
      for (let [k, c] of game.colours) {
        if (c.colour === colour.colour) {
          allCells.push(k)
        }
      }

      let action = (e.metaKey || e.ctrlKey) ? ACTION_PUSH : ACTION_SET
      updateGame({
        type: TYPE_SELECTION,
        action,
        k: allCells
      })
    }
  }

  const onTouchMove = useCallback(e => {
    let touch = e.touches[0]
    let x = touch.pageX
    let y = touch.pageY
    let interactionManager = app.current.renderer.plugins.interaction
    let p = {}
    interactionManager.mapPositionToPoint(p, x, y)
    let hit = interactionManager.hitTest(p, cellsElement.current)
    if (hit?.data?.k !== undefined) {
      selectCell(hit, e, true)
    }
  }, [selectCell])

  const onPointerUp = useCallback(e => {
    let pwc = penCurrentWaypoints.current
    if (pwc.length > 0) {
      let penLines = []
      for (let i = 0; i < pwc.length - 1; ++i) {
        let k = penWaypointsToKey(pwc[i], pwc[i + 1], penCurrentDrawEdge.current)
        if (k !== undefined) {
          penLines.push(k)
        }
      }
      let action
      if (penCurrentWaypointsAdd.current) {
        action = ACTION_PUSH
      } else {
        action = ACTION_REMOVE
      }
      updateGame({
        type: TYPE_PENLINES,
        action,
        k: penLines
      })
      penCurrentWaypoints.current = []
      penCurrentDrawEdge.current = false

      // render waypoints (this will basically remove them from the grid)
      penCurrentWaypointsElements.current.forEach(e => e.data.draw())
      renderNow()
    }
  }, [updateGame, renderNow])

  // Custom render loop. Render on demand and then repeat rendering for
  // MAX_RENDER_LOOP_TIME milliseconds. Then pause rendering again. This has
  // two benefits: (1) it forces the browser to refresh the screen as quickly
  // as possible (without this, there might be lags of 500ms - 1s every now
  // and then!), (2) it saves CPU cycles and therefore battery.
  const renderNow = useCallback(() => {
    function doRender() {
      let elapsed = new Date() - renderLoopStarted.current
      if (app.current !== undefined && elapsed < MAX_RENDER_LOOP_TIME) {
        rendering.current = true
        app.current.render()
        requestAnimationFrame(doRender)
      } else {
        rendering.current = false
      }
    }

    renderLoopStarted.current = +new Date()
    if (!rendering.current) {
      doRender()
    }
  }, [])

  useEffect(() => {
    currentMode.current = game.mode

    if (app.current !== undefined) {
      if (game.mode === MODE_PEN) {
        app.current.renderer.plugins.interaction.cursorStyles.pointer = "crosshair"
      } else {
        app.current.renderer.plugins.interaction.cursorStyles.pointer = "pointer"
      }
    }
    penHitareaElements.current.forEach(e => e.visible = game.mode === MODE_PEN)

    penCurrentWaypoints.current = []
  }, [game.mode])

  useEffect(() => {
    // optimised resolution for different screens
    let resolution = Math.min(window.devicePixelRatio,
      window.devicePixelRatio === 2 ? 3 : 2.5)

    // create PixiJS app
    let newApp = new PIXI.Application({
      resolution,
      antialias: true,
      backgroundAlpha: 0,
      autoDensity: true,
      autoStart: false
    })
    ref.current.appendChild(newApp.view)
    app.current = newApp

    // it seems we don't need the system ticker, so stop it
    PIXI.Ticker.system.stop()

    // Disable accessibility manager. We don't need it. Also, if it is enabled,
    // it creates an invisible div on top of our grid when the user presses the
    // tab key, which resets the cursor. We don't want the cursor to be reset!
    newApp.renderer.plugins.accessibility.destroy()

    // good for dpi < 2
    if (window.devicePixelRatio < 2) {
      PIXI.settings.ROUND_PIXELS = true
    }

    // register touch handler
    newApp.view.addEventListener("touchmove", onTouchMove)
    document.addEventListener("pointerup", onPointerUp, false)
    document.addEventListener("pointercancel", onPointerUp, false)
    document.addEventListener("touchend", onPointerUp, false)
    document.addEventListener("touchcancel", onPointerUp, false)

    let themeColours = getThemeColours(ref.current)

    let fontSizeCageLabels = 26

    // create grid
    let all = new PIXI.Container()
    allElement.current = all
    let grid = new PIXI.Container()
    gridElement.current = grid
    let cells = new PIXI.Container()
    cellsElement.current = cells

    all.sortableChildren = true
    grid.sortableChildren = true

    // ***************** Layers and zIndexes:

    // all                            sortable
    //   background            -1000
    //   extra regions           -20
    //   underlays               -10
    //   lines and arrows         -1
    //   arrow heads              -1
    //   colour                    0
    //   errors                   10
    //   selection                20
    //   grid                     30  sortable
    //     region                 10
    //     cage outline            1
    //     cage label              3
    //     cage label background   2
    //     cells
    //       cell                  0
    //   overlays                 40
    //   given corner marks       41
    //   digit                    50
    //   corner marks             50
    //   centre marks             50
    //   pen lines                60
    //   pen waypoints            70
    //   pen tool hitarea         80

    // ***************** render everything that could contribute to bounds

    // render cells
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let cell = new PIXI.Graphics()
        cell.interactive = true
        cell.buttonMode = true
        cell.cursor = "pointer"

        cell.data = {
          k: xytok(x, y),
          draw: function (cellSize) {
            cell.lineStyle({ width: 1, color: themeColours.foregroundColor })
            cell.drawRect(0, 0, cellSize, cellSize)

            cell.x = x * cellSize
            cell.y = y * cellSize

            // since our cells have a transparent background, we need to
            // define a hit area
            cell.hitArea = new PIXI.Rectangle(0, 0, cellSize, cellSize)
          }
        }

        cell.on("pointerdown", function (e) {
          selectCell(this, e)
          e.stopPropagation()
          e.data.originalEvent.preventDefault()
        })

        cell.on("pointerover", function (e) {
          if (e.data.buttons === 1) {
            selectCell(this, e, true)
          }
          e.stopPropagation()
        })

        cells.addChild(cell)
        cellElements.current.push(cell)
      })
    })

    // render regions
    for (let r of regions) {
      let poly = new PIXI.Graphics()
      poly.data = {
        draw: function (cellSize) {
          poly.lineStyle({ width: 3, color: themeColours.foregroundColor })
          poly.drawPolygon(r.map(v => v * cellSize))
        }
      }
      poly.zIndex = 10
      grid.addChild(poly)
      regionElements.current.push(poly)
    }

    // render cages
    for (let cage of cages) {
      // draw outline
      let poly = new PIXI.Graphics()
      poly.zIndex = 1
      poly.data = {
        borderColor: cage.borderColor ? getRGBColor(cage.borderColor) : undefined,
        draw: function (cellSize) {
          let disposedOutline = disposePolygon(cage.outline.map(v => v * cellSize),
            regions.map(rarr => rarr.map(v => v * cellSize)), 1)
          let shrunkenOutline = shrinkPolygon(disposedOutline, 3)
          let color = cage.borderColor ? getRGBColor(cage.borderColor) :
              themeColours.foregroundColor
          poly.lineStyle({ width: 1, color })
          drawDashedPolygon(shrunkenOutline, 3, 2, poly)
        }
      }
      grid.addChild(poly)
      cageElements.current.push(poly)

      if (cage.value !== undefined && cage.value !== null && `${cage.value}`.trim() !== "") {
        // create cage label
        // use larger font and scale down afterwards to improve text rendering
        let topleftText = new PIXI.Text(cage.value, {
          fontFamily: "Roboto, sans-serif",
          fontSize: fontSizeCageLabels
        })
        topleftText.zIndex = 3
        topleftText.scale.x = 0.5
        topleftText.scale.y = 0.5
        topleftText.data = {
          draw: function (cellSize) {
            topleftText.x = cage.topleft[1] * cellSize + cellSize / 20
            topleftText.y = cage.topleft[0] * cellSize + cellSize / 60
          }
        }
        grid.addChild(topleftText)
        cageLabelTextElements.current.push(topleftText)

        let topleftBg = new PIXI.Graphics()
        topleftBg.zIndex = 2
        topleftBg.data = {
          draw: function (cellSize) {
            topleftBg.beginFill(0xffffff)
            topleftBg.drawRect(0, 0, topleftText.width + cellSize / 10 - 1,
                topleftText.height + cellSize / 60)
            topleftBg.endFill()
            topleftBg.x = cage.topleft[1] * cellSize + 0.5
            topleftBg.y = cage.topleft[0] * cellSize + 0.5
          }
        }
        grid.addChild(topleftBg)
        cageLabelBackgroundElements.current.push(topleftBg)
      }
    }

    grid.addChild(cells)
    grid.zIndex = 30
    all.addChild(grid)

    // render extra regions
    for (let r of extraRegions) {
      let poly = new PIXI.Graphics()
      poly.zIndex = -20
      poly.data = {
        draw: function (cellSize) {
          let disposedOutline = disposePolygon(r.outline.map(v => v * cellSize),
          regions.map(rarr => rarr.map(v => v * cellSize)), 1)
          let shrunkenOutline = shrinkPolygon(disposedOutline, 3)
          poly.beginFill(getRGBColor(r.backgroundColor))
          poly.drawPolygon(shrunkenOutline)
          poly.endFill()
        }
      }
      all.addChild(poly)
      extraRegionElements.current.push(poly)
    }

    // sort lines and arrows by thickness
    let lines = [
      ...game.data.lines.map(l => ({ ...l, isArrow: false })),
      ...game.data.arrows.map(a => ({ ...a, isArrow: true }))
    ]
    lines.sort((a, b) => b.thickness - a.thickness)

    // add lines and arrows
    lines.forEach(line => {
      let poly = new PIXI.Graphics()
      poly.zIndex = -1
      poly.data = {
        draw: function (cellSize) {
          let points = shortenLine(filterDuplicatePoints(flatten(line.wayPoints.map(wp =>
              cellToScreenCoords(wp, grid.x, grid.y, cellSize)))))
          poly.lineStyle({
            width: line.thickness * SCALE_FACTOR,
            color: getRGBColor(line.color),
            cap: PIXI.LINE_CAP.ROUND,
            join: PIXI.LINE_JOIN.ROUND
          })
          let lvx = 0
          let lvy = 0
          poly.moveTo(points[0], points[1])
          for (let i = 2; i < points.length; i += 2) {
            // calculate direction
            let vx = points[i] - points[i - 2]
            let vy = points[i + 1] - points[i - 1]
            let vl = Math.sqrt(vx * vx + vy * vy)
            vx /= vl
            vy /= vl

            // Start new line if we're going backwards (i.e. if the direction
            // of the current line segement is opposite the direction of the
            // last segment. We need to do this to make caps at such turning
            // points actually round and to avoid other drawing issues.
            if (vx === lvx && vy === -lvy || vx === -lvx && vy === lvy) {
              poly.moveTo(points[i - 2], points[i - 1])
            }

            poly.lineTo(points[i], points[i + 1])

            lvx = vx
            lvy = vy
          }
        }
      }
      all.addChild(poly)
      lineElements.current.push(poly)

      // arrow heads
      if (line.isArrow && line.wayPoints.length > 1) {
        let head = new PIXI.Graphics()
        head.zIndex = -1
        head.data = {
          draw: function (cellSize) {
            let points = shortenLine(filterDuplicatePoints(flatten(line.wayPoints.map(wp =>
                cellToScreenCoords(wp, grid.x, grid.y, cellSize)))))
            let lastPointX = points[points.length - 2]
            let lastPointY = points[points.length - 1]
            let secondToLastX = points[points.length - 4]
            let secondToLastY = points[points.length - 3]
            let dx = lastPointX - secondToLastX
            let dy = lastPointY - secondToLastY
            let l = Math.sqrt(dx * dx + dy * dy)
            dx /= l
            dy /= l
            let f = Math.min(line.headLength * cellSize * 0.7, l / 3)
            let ex = lastPointX - dx * f
            let ey = lastPointY - dy * f
            let ex1 = ex - dy * f
            let ey1 = ey + dx * f
            let ex2 = ex + dy * f
            let ey2 = ey - dx * f
            head.lineStyle({
              width: line.thickness * SCALE_FACTOR,
              color: getRGBColor(line.color),
              cap: PIXI.LINE_CAP.ROUND,
              join: PIXI.LINE_JOIN.ROUND
            })
            head.moveTo(lastPointX, lastPointY)
            head.lineTo(ex1, ey1)
            head.moveTo(lastPointX, lastPointY)
            head.lineTo(ex2, ey2)
          }
        }
        all.addChild(head)
        lineElements.current.push(head)
      }
    })

    // add underlays and overlays
    game.data.underlays.forEach(underlay => {
      let e = drawOverlay(underlay, grid.x, grid.y, -10)
      all.addChild(e)
      underlayElements.current.push(e)
    })
    game.data.overlays.forEach(overlay => {
      let e = drawOverlay(overlay, grid.x, grid.y, 40)
      all.addChild(e)
      overlayElements.current.push(e)
    })

    // draw a background that covers all elements
    let background = new PIXI.Graphics()
    background.interactive = true
    background.zIndex = -1000
    background.on("pointerdown", () => {
      if (currentMode.current !== MODE_PEN) {
        updateGame({
          type: TYPE_SELECTION,
          action: ACTION_CLEAR
        })
      }
    })
    backgroundElement.current = background

    app.current.stage.addChild(background)
    app.current.stage.addChild(all)

    // ***************** draw other elements that don't contribute to the bounds

    // create text elements for given corner marks
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let arr = col.pencilMarks
        if (arr === undefined) {
          return
        }
        if (!Array.isArray(arr)) {
          arr = [arr]
        }

        let hcv = hasCageValue(x, y, cages)
        let cms = makeCornerMarks(x, y, cellSize, FONT_SIZE_CORNER_MARKS_HIGH_DPI,
            hcv, arr.length, "bold")
        cms.forEach((cm, i) => {
          cm.zIndex = 41
          cm.style.fill = themeColours.foregroundColor
          cm.text = arr[i]
          all.addChild(cm)
          givenCornerMarkElements.current.push(cm)
        })
      })
    })

    // ***************** draw invisible elements but don't call render() again!

    // create empty text elements for all digits
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let text = new PIXI.Text("", {
          fontFamily: "Roboto, sans-serif",
          fontSize: FONT_SIZE_DIGITS
        })
        text.visible = false
        text.zIndex = 50
        text.anchor.set(0.5)
        text.data = {
          k: xytok(x, y),
          draw: function (cellSize) {
            text.x = x * cellSize + cellSize / 2
            text.y = y * cellSize + cellSize / 2 - 0.5
          }
        }
        all.addChild(text)
        digitElements.current.push(text)
      })
    })

    // create empty text elements for corner marks
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let cell = {
          data: {
            k: xytok(x, y)
          },
          elements: []
        }

        let leaveRoom = hasCageValue(x, y, cages) || hasGivenCornerMarks(col)
        let cms = makeCornerMarks(x, y, cellSize, FONT_SIZE_CORNER_MARKS_HIGH_DPI,
            leaveRoom, 11)
        for (let cm of cms) {
          cm.visible = false
          cm.zIndex = 50
          cm.style.fill = themeColours.digitColor
          all.addChild(cm)
          cell.elements.push(cm)
        }

        cornerMarkElements.current.push(cell)
      })
    })

    // create empty text elements for centre marks
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let text = new PIXI.Text("", {
          fontFamily: "Roboto, sans-serif",
          fontSize: FONT_SIZE_CENTRE_MARKS_HIGH_DPI
        })
        text.zIndex = 50
        text.anchor.set(0.5)
        text.style.fill = themeColours.digitColor
        text.scale.x = 0.5
        text.scale.y = 0.5
        text.visible = false
        text.data = {
          k: xytok(x, y),
          draw: function (cellSize) {
            text.x = x * cellSize + cellSize / 2
            text.y = y * cellSize + cellSize / 2 - 0.5
          }
        }
        all.addChild(text)
        centreMarkElements.current.push(text)
      })
    })

    // create invisible rectangles for colours
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let rect = new PIXI.Graphics()
        rect.alpha = 0
        rect.zIndex = 0
        rect.data = {
          k: xytok(x, y),
          draw: function (cellSize) {
            rect.x = x * cellSize
            rect.y = y * cellSize
          }
        }
        all.addChild(rect)
        colourElements.current.push(rect)
      })
    })

    // create invisible rectangles for selection
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let rect = new PIXI.Graphics()
        rect.visible = false
        rect.zIndex = 20
        rect.data = {
          k: xytok(x, y),
          draw: function (cellSize) {
            rect.beginFill(0xffde2a, 0.5)
            rect.drawRect(0.5, 0.5, cellSize - 1, cellSize - 1)
            rect.endFill()
            rect.x = x * cellSize
            rect.y = y * cellSize
          }
        }
        all.addChild(rect)
        selectionElements.current.push(rect)
      })
    })

    // create invisible rectangles for errors
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        let rect = new PIXI.Graphics()
        rect.visible = false
        rect.zIndex = 10
        rect.data = {
          k: xytok(x, y),
          draw: function (cellSize) {
            rect.beginFill(0xb33a3a, 0.5)
            rect.drawRect(0.5, 0.5, cellSize - 1, cellSize - 1)
            rect.endFill()
            rect.x = x * cellSize
            rect.y = y * cellSize
          }
        }
        all.addChild(rect)
        errorElements.current.push(rect)
      })
    })

    // create invisible elements for pen lines
    game.data.cells.forEach((row, y) => {
      row.forEach((col, x) => {
        function makeLine(rx, ry, horiz, dx, dy, type) {
          let line = new PIXI.Graphics()
          line.visible = false
          line.zIndex = 60
          line.data = {
            k: pltok(rx, ry, type),
            draw: function (cellSize) {
              line.lineStyle({
                width: 2 * SCALE_FACTOR,
                color: 0,
                cap: PIXI.LINE_CAP.ROUND,
                join: PIXI.LINE_JOIN.ROUND
              })
              line.moveTo(0, 0)
              if (horiz) {
                line.lineTo(cellSize, 0)
              } else {
                line.lineTo(0, cellSize)
              }
              line.x = (rx + dx) * cellSize
              line.y = (ry + dy) * cellSize
            }
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
    let penWaypoints = new PIXI.Graphics()
    penWaypoints.zIndex = 70
    penWaypoints.data = {
      draw: function (cellSize) {
        this.cellSize = cellSize || this.cellSize
        if (this.cellSize === undefined) {
          return
        }

        let wps = penCurrentWaypoints.current
        penWaypoints.clear()
        if (wps.length > 1) {
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
          penWaypoints.lineStyle({
            width: 3 * SCALE_FACTOR,
            color,
            cap: PIXI.LINE_CAP.ROUND,
            join: PIXI.LINE_JOIN.ROUND
          })
          let p0 = ktoxy(wps[0])
          penWaypoints.moveTo((p0[0] + d) * this.cellSize, (p0[1] + d) * this.cellSize)
          for (let i = 0; i < wps.length - 1; ++i) {
            let p = ktoxy(wps[i + 1])
            penWaypoints.lineTo((p[0] + d) * this.cellSize, (p[1] + d) * this.cellSize)
          }
        }
      }
    }
    all.addChild(penWaypoints)
    penCurrentWaypointsElements.current.push(penWaypoints)

    // add invisible hit area for pen tool
    let penHitArea = new PIXI.Graphics()
    penHitArea.interactive = true
    penHitArea.buttonMode = true
    penHitArea.cursor = "crosshair"
    penHitArea.zIndex = 80
    penHitArea.visible = false
    penHitArea.data = {
      draw: function (cellSize) {
        penHitArea.hitArea = new PIXI.Rectangle(0, 0,
          game.data.cells[0].length * cellSize,
          game.data.cells.length * cellSize)
          penHitArea.removeAllListeners()
          penHitArea.on("pointermove", e => onPenMove(e, cellSize))
      }
    }
    all.addChild(penHitArea)
    penHitareaElements.current.push(penHitArea)

    if (onFinishRender) {
      onFinishRender()
    }

    return () => {
      allElement.current = undefined
      gridElement.current = undefined
      cellsElement.current = undefined
      cellElements.current = []
      regionElements.current = []
      cageElements.current = []
      cageLabelTextElements.current = []
      cageLabelBackgroundElements.current = []
      lineElements.current = []
      extraRegionElements.current = []
      underlayElements.current = []
      overlayElements.current = []
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

      document.removeEventListener("touchcancel", onPointerUp)
      document.removeEventListener("touchend", onPointerUp)
      document.removeEventListener("pointercancel", onPointerUp)
      document.removeEventListener("pointerup", onPointerUp)
      newApp.view.removeEventListener("touchmove", onTouchMove)
      newApp.destroy(true, true)
      app.current = undefined
    }
  }, [game.data, cellSize, regions, cages, extraRegions, selectCell, onPenMove,
    updateGame, onFinishRender, onTouchMove, onPointerUp])

  useEffect(() => {
    let cs = cellSize * (settings.zoom + ZOOM_DELTA)
    let allBounds
    let gridBounds

    cellSizeFactor.current = settings.zoom + ZOOM_DELTA
    allElement.current.x = allElement.current.y = 0

    for (let i = 0; i < 10; ++i) {
      let elementsToRedraw = [cellElements, regionElements, cageElements,
        cageLabelTextElements, cageLabelBackgroundElements, lineElements,
        extraRegionElements, underlayElements, overlayElements,
        givenCornerMarkElements, digitElements, centreMarkElements, colourElements,
        selectionElements, errorElements, penCurrentWaypointsElements,
        penLineElements, penHitareaElements]
      for (let r of elementsToRedraw) {
        for (let e of r.current) {
          if (e.clear !== undefined) {
            e.clear()
          }
          e.data.draw(cs, cellSizeFactor.current)
        }
      }
      for (let e of cornerMarkElements.current) {
        for (let ce of e.elements) {
          ce.data.draw(cs)
        }
      }

      allElement.current.calculateBounds()
      allBounds = allElement.current.getBounds()
      gridBounds = gridElement.current.getBounds()

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
      cellSizeFactor.current = Math.min(sx, sy) * (settings.zoom + ZOOM_DELTA)
      cs = Math.floor(cellSize * cellSizeFactor.current)
    }

    let marginTop = gridBounds.y - allBounds.y
    let marginBottom = allBounds.y + allBounds.height -
      (gridBounds.y + gridBounds.height)
    let marginLeft = gridBounds.x - allBounds.x
    let marginRight = allBounds.x + allBounds.width -
      (gridBounds.x + gridBounds.width)
    let additionalMarginX = 0
    let additionalMarginY = 0
    if (portrait) {
      additionalMarginX = Math.abs(marginLeft - marginRight)
    } else {
      additionalMarginY = Math.abs(marginTop - marginBottom)
    }

    let w = allBounds.width
    let h = allBounds.height

    app.current.renderer.resize(w, h)
    allElement.current.x = -allBounds.x
    allElement.current.y = -allBounds.y

    if (marginTop > marginBottom) {
      ref.current.style.marginTop = "0"
      ref.current.style.marginBottom = `${additionalMarginY}px`
    } else {
      ref.current.style.marginTop = `${additionalMarginY}px`
      ref.current.style.marginBottom = "0"
    }
    if (marginLeft > marginRight) {
      ref.current.style.marginLeft = "0"
      ref.current.style.marginRight = `${additionalMarginX}px`
    } else {
      ref.current.style.marginLeft = `${additionalMarginX}px`
      ref.current.style.marginRight = "0"
    }

    // check if we're currently hovering over an element that has a custom cursor
    let interactionManager = app.current.renderer.plugins.interaction
    let pos = interactionManager.mouse.global
    let hit = interactionManager.hitTest(pos, allElement.current)
    if (hit?.cursor !== undefined) {
      // reset cursor mode before setting the new one - otherwise, the cursor
      // will not change at all
      interactionManager.setCursorMode("default")
      interactionManager.setCursorMode(hit.cursor)
    }
  }, [cellSize, maxWidth, maxHeight, portrait, settings.zoom, game.mode])

  // register keyboard handlers
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown)

    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [onKeyDown])

  useEffect(() => {
    let themeColours = getThemeColours(ref.current)

    // optimised font sizes for different screens
    let fontSizeCornerMarks = window.devicePixelRatio >= 2 ?
        FONT_SIZE_CORNER_MARKS_HIGH_DPI : FONT_SIZE_CORNER_MARKS_LOW_DPI
    let fontSizeCentreMarks = window.devicePixelRatio >= 2 ?
        FONT_SIZE_CENTRE_MARKS_HIGH_DPI : FONT_SIZE_CENTRE_MARKS_LOW_DPI

    // scale fonts
    let fontSizeDigits = FONT_SIZE_DIGITS * settings.fontSizeFactorDigits
    fontSizeCornerMarks *= settings.fontSizeFactorCornerMarks
    fontSizeCentreMarks *= settings.fontSizeFactorCentreMarks

    // change font size of digits
    for (let e of digitElements.current) {
      e.style.fontSize = Math.round(fontSizeDigits * cellSizeFactor.current)
    }

    // change font size of corner marks
    for (let e of cornerMarkElements.current) {
      for (let ce of e.elements) {
        ce.style.fontSize = Math.round(fontSizeCornerMarks * cellSizeFactor.current)
      }
    }

    // change font size of centre marks
    for (let e of centreMarkElements.current) {
      e.style.fontSize = Math.round(fontSizeCentreMarks * cellSizeFactor.current)
    }

    // change font size and colour of given corner marks
    for (let e of givenCornerMarkElements.current) {
      e.style.fontSize = Math.round(fontSizeCornerMarks * cellSizeFactor.current)
      e.style.fill = themeColours.foregroundColor
    }

    // change selection colour
    for (let e of selectionElements.current) {
      e.geometry.graphicsData[0].fillStyle.color =
        themeColours.selection[settings.selectionColour]
      e.geometry.invalidate()
    }

    // change line colour of cells, regions, cages
    changeLineColour(cellElements.current, themeColours.foregroundColor)
    changeLineColour(regionElements.current, themeColours.foregroundColor)
    changeLineColour(cageElements.current, themeColours.foregroundColor)

    // change background colour
    backgroundElement.current.clear()
    drawBackground(backgroundElement.current, app.current.renderer.width,
      app.current.renderer.height, themeColours)
  }, [settings.theme, settings.selectionColour, settings.zoom, settings.fontSizeFactorDigits,
      settings.fontSizeFactorCentreMarks, settings.fontSizeFactorCornerMarks,
      maxWidth, maxHeight, portrait, game.mode])

  useEffect(() => {
    selectionElements.current.forEach(s => {
      s.visible = game.selection.has(s.data.k)
    })
    renderNow()
  }, [game.selection, renderNow])

  useEffect(() => {
    let themeColours = getThemeColours(ref.current)
    let cornerMarks = new Map()
    let centreMarks = new Map()

    for (let e of cornerMarkElements.current) {
      let digits = game.cornerMarks.get(e.data.k)
      for (let ce of e.elements) {
        ce.visible = false
      }
      if (digits !== undefined) {
        [...digits].sort().forEach((d, i) => {
          let n = i
          if (digits.size > 8 && n > 4) {
            n++
          }
          e.elements[n].text = d
          e.elements[n].style.fill = themeColours.smallDigitColor
          e.elements[n].visible = true
        })
        cornerMarks.set(e.data.k, e)
      }
    }

    for (let e of centreMarkElements.current) {
      let digits = game.centreMarks.get(e.data.k)
      if (digits !== undefined) {
        e.text = [...digits].sort().join("")
        e.style.fill = themeColours.smallDigitColor
        e.visible = true
        centreMarks.set(e.data.k, e)
      } else {
        e.visible = false
      }
    }

    for (let e of digitElements.current) {
      let digit = game.digits.get(e.data.k)
      if (digit !== undefined) {
        e.text = digit.digit
        e.style.fill = digit.given ? themeColours.foregroundColor : themeColours.digitColor
        e.visible = true

        let com = cornerMarks.get(e.data.k)
        if (com !== undefined) {
          for (let ce of com.elements) {
            ce.visible = false
          }
        }

        let cem = centreMarks.get(e.data.k)
        if (cem !== undefined) {
          cem.visible = false
        }
      } else {
        e.visible = false
      }
    }

    let scaledCellSize = Math.floor(cellSize * cellSizeFactor.current)
    let colourPalette = settings.colourPalette
    if (colourPalette === "custom" && settings.customColours.length === 0) {
      colourPalette = "default"
    }
    let colours = []
    if (colourPalette !== "custom") {
      let computedStyle = getComputedStyle(ref.current)
      let nColours = +computedStyle.getPropertyValue("--colors")
      for (let i = 0; i < nColours; ++i) {
        colours[i] = computedStyle.getPropertyValue(`--color-${i + 1}`)
      }
    } else {
      colours = settings.customColours
    }
    for (let e of colourElements.current) {
      let colour = game.colours.get(e.data.k)
      if (colour !== undefined) {
        let palCol = colours[colour.colour - 1]
        if (palCol === undefined) {
          palCol = colours[1] || colours[0]
        }
        let colourNumber = getRGBColor(palCol)
        e.clear()
        e.beginFill(colourNumber)
        e.drawRect(0.5, 0.5, scaledCellSize - 1, scaledCellSize - 1)
        e.endFill()
        if (colourNumber === 0xffffff) {
          e.alpha = 1.0
        } else {
          e.alpha = 0.5
        }
      } else {
        e.alpha = 0
      }
    }

    for (let pl of penLineElements.current) {
      pl.visible = game.penLines.has(pl.data.k)
    }

    for (let e of errorElements.current) {
      e.visible = game.errors.has(e.data.k)
    }

    renderNow()
  }, [cellSize, game.digits, game.cornerMarks, game.centreMarks, game.colours,
      game.penLines, game.errors, settings.theme, settings.colourPalette,
      settings.selectionColour, settings.customColours, settings.zoom,
      settings.fontSizeFactorDigits, settings.fontSizeFactorCentreMarks,
      settings.fontSizeFactorCornerMarks, maxWidth, maxHeight, portrait,
      renderNow, game.mode])

  return (
    <div ref={ref} className="grid" onClick={onBackgroundClick} onDoubleClick={onDoubleClick}>
      <style jsx>{styles}</style>
    </div>
  )
}

export default Grid
