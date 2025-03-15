import Palette from "./Palette"
import RadioGroup from "./RadioGroup"
import RangeSlider from "./RangeSlider"
import { useSettings } from "./hooks/useSettings"
import { useEffect, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"

const Slider = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-4 max-w-[7rem]">{children}</div>
)

const PaletteLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-col items-start">{children}</div>
)

const Settings = () => {
  const {
    colourPalette,
    theme,
    customColours,
    zoom,
    fontSizeFactorDigits,
    fontSizeFactorCornerMarks,
    fontSizeFactorCentreMarks,
    setColourPalette,
    setTheme,
    setCustomColours: setSettingsCustomColours,
    setZoom,
    setFontSizeFactorDigits,
    setFontSizeFactorCornerMarks,
    setFontSizeFactorCentreMarks,
  } = useSettings(
    useShallow(state => ({
      colourPalette: state.colourPalette,
      theme: state.theme,
      customColours: state.customColours,
      zoom: state.zoom,
      fontSizeFactorDigits: state.fontSizeFactorDigits,
      fontSizeFactorCornerMarks: state.fontSizeFactorCornerMarks,
      fontSizeFactorCentreMarks: state.fontSizeFactorCentreMarks,
      setColourPalette: state.setColourPalette,
      setTheme: state.setTheme,
      setCustomColours: state.setCustomColours,
      setZoom: state.setZoom,
      setFontSizeFactorDigits: state.setFontSizeFactorDigits,
      setFontSizeFactorCornerMarks: state.setFontSizeFactorCornerMarks,
      setFontSizeFactorCentreMarks: state.setFontSizeFactorCentreMarks,
    })),
  )

  const refPlaceholderCTC = useRef<HTMLDivElement>(null)
  const refPlaceholderWong = useRef<HTMLDivElement>(null)

  const [coloursDefault, setColoursDefault] = useState<string[]>([])
  const [coloursCTC, setColoursCTC] = useState<string[]>([])
  const [coloursWong, setColoursWong] = useState<string[]>([])
  const [coloursCustom, setColoursCustom] = useState(customColours)

  function zoomValueToDescription(value: number) {
    if (value === 1) {
      return "Default"
    }
    return `x${value}`
  }

  function fontSizeValueToDescription(value: number): string | undefined {
    if (value === 0.75) {
      return "Tiny"
    } else if (value === 0.875) {
      return "Small"
    } else if (value === 1) {
      return "Normal"
    } else if (value === 1.125) {
      return "Large"
    } else if (value === 1.25) {
      return "X-Large"
    } else if (value === 1.375) {
      return "XX-Large"
    } else if (value === 1.5) {
      return "Maximum"
    }
    return undefined
  }

  function onUpdateCustomColours(colours: string[]) {
    setColoursCustom(colours)
    setSettingsCustomColours(colours)
  }

  useEffect(() => {
    function makeColours(elem: Element): string[] {
      let style = getComputedStyle(elem)
      let nColours = +style.getPropertyValue("--colors")
      let result = []
      for (let i = 0; i < nColours; ++i) {
        let pos = +style.getPropertyValue(`--color-${i + 1}-pos`)
        result[pos - 1] = style.getPropertyValue(`--color-${i + 1}`)
      }
      return result
    }

    let defaultColours = makeColours(document.body)
    setColoursDefault(defaultColours)
    setColoursCTC(makeColours(refPlaceholderCTC.current!))
    setColoursWong(makeColours(refPlaceholderWong.current!))
    setColoursCustom(old => (old.length === 0 ? defaultColours : old))
  }, [])

  return (
    <div className="sidebar-page">
      <h2>Settings</h2>

      <h3>Theme</h3>
      <RadioGroup
        name="theme"
        ariaLabel="Select theme"
        value={theme}
        options={[
          {
            id: "default",
            label: "Sudocle",
          },
          {
            id: "dark",
            label: "Dark",
          },
        ]}
        onChange={setTheme}
      />

      <h3>Colour Palette</h3>
      <div data-colour-palette="ctc" ref={refPlaceholderCTC} />
      <div data-colour-palette="wong" ref={refPlaceholderWong} />
      <RadioGroup
        name="colourPalette"
        ariaLabel="Select colour palette"
        value={colourPalette}
        options={[
          {
            id: "default",
            label: (
              <PaletteLabel>
                <div>Sudocle</div>
                <Palette colours={coloursDefault} />
              </PaletteLabel>
            ),
          },
          {
            id: "ctc",
            label: (
              <PaletteLabel>
                <div>Cracking the Cryptic</div>
                <Palette colours={coloursCTC} />
              </PaletteLabel>
            ),
          },
          {
            id: "wong",
            label: (
              <PaletteLabel>
                <div>Wong (optimised for colour-blindness)</div>
                <Palette colours={coloursWong} />
              </PaletteLabel>
            ),
          },
          {
            id: "custom",
            label: (
              <PaletteLabel>
                <div>Custom</div>
                <Palette
                  colours={coloursCustom}
                  customisable={true}
                  updatePalette={onUpdateCustomColours}
                />
              </PaletteLabel>
            ),
          },
        ]}
        onChange={setColourPalette}
      />

      <h3>Zoom</h3>
      <Slider>
        <RangeSlider
          id="range-zoom"
          min={0.9}
          max={1.25}
          step={0.05}
          value={zoom}
          onChange={setZoom}
          valueToDescription={zoomValueToDescription}
        />
      </Slider>

      <h3>Font sizes</h3>
      <Slider>
        <RangeSlider
          id="range-digits"
          label="Digits"
          min={0.75}
          max={1.5}
          step={0.125}
          value={fontSizeFactorDigits}
          onChange={setFontSizeFactorDigits}
          valueToDescription={fontSizeValueToDescription}
        />
      </Slider>
      <Slider>
        <RangeSlider
          id="range-corner-marks"
          label="Corner marks"
          min={0.75}
          max={1.5}
          step={0.125}
          value={fontSizeFactorCornerMarks}
          onChange={setFontSizeFactorCornerMarks}
          valueToDescription={fontSizeValueToDescription}
        />
      </Slider>
      <Slider>
        <RangeSlider
          id="range-centre-marks"
          label="Centre marks"
          min={0.75}
          max={1.5}
          step={0.125}
          value={fontSizeFactorCentreMarks}
          onChange={setFontSizeFactorCentreMarks}
          valueToDescription={fontSizeValueToDescription}
        />
      </Slider>

      <h3>Saved Progress</h3>
      <div className="mb-4">
        <button
          className="bg-fg-400 hover:bg-fg-500 text-bg-100 font-semibold py-2 px-4 rounded"
          onClick={() => {
            // Get the current puzzle ID using similar logic to the useGame hook
            let id = window.location.pathname

            // Process the path
            if (id.endsWith("/")) {
              id = id.substring(0, id.length - 1)
            }
            if (id.startsWith("/")) {
              id = id.substring(1)
            }

            // Extract the last part of the path as the puzzle ID
            const pathParts = id.split("/")
            const currentPuzzleId =
              pathParts.length > 0 ? pathParts[pathParts.length - 1] : ""

            // Check URL params if path is empty
            let puzzleId = currentPuzzleId
            if (!puzzleId) {
              const params = new URLSearchParams(window.location.search)
              const paramId = params.get("puzzleid")
              const fpuzzlesId = params.get("fpuzzles")
              const fpuz = params.get("fpuz")
              const ctcId = params.get("ctc")
              const sclId = params.get("scl")

              if (fpuzzlesId) puzzleId = "fpuzzles" + fpuzzlesId
              else if (fpuz) puzzleId = "fpuz" + fpuz
              else if (ctcId) puzzleId = "ctc" + ctcId
              else if (sclId) puzzleId = "scl" + sclId
              else if (paramId) puzzleId = paramId
              else if (params.get("test")) puzzleId = "test"
            }

            if (puzzleId) {
              localStorage.removeItem("sudocle_game_" + puzzleId)
              alert("Progress for current puzzle cleared.")
              // Reload the page to reset the game
              window.location.reload()
            } else {
              alert("No puzzle detected.")
            }
          }}
        >
          Clear Current Puzzle Progress
        </button>
      </div>
      <div className="mb-4">
        <button
          className="bg-alert hover:bg-alert-600 text-bg-100 font-semibold py-2 px-4 rounded"
          onClick={() => {
            if (
              confirm(
                "Are you sure you want to clear ALL saved puzzle progress? This cannot be undone.",
              )
            ) {
              // Clear all puzzle progress
              const keysToRemove = []
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i)
                if (key && key.startsWith("sudocle_game_")) {
                  keysToRemove.push(key)
                }
              }
              keysToRemove.forEach(key => localStorage.removeItem(key))
              alert("All puzzle progress cleared.")
              // Reload the page to reset the game
              window.location.reload()
            }
          }}
        >
          Clear ALL Saved Progress
        </button>
      </div>
    </div>
  )
}

export default Settings
