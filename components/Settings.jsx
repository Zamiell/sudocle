import RadioGroup from "./RadioGroup"
import RangeSlider from "./RangeSlider"
import SettingsContext from "./contexts/SettingsContext"
import { useContext, useEffect, useRef, useState } from "react"
import classNames from "classnames"
import { Check } from "lucide-react"
import styles from "./Settings.scss"

function Palette({ colours }) {
  return <div className="palette">{
    colours.map((c, i) => <div key={i} className="colour" style={{ backgroundColor: c }}></div>)
  }<style jsx>{styles}</style></div>
}

const Settings = () => {
  const settings = useContext(SettingsContext.State)
  const updateSettings = useContext(SettingsContext.Dispatch)
  const [themeInternal, setThemeInternal] = useState(settings.theme)

  const refPlaceholderExtended = useRef()
  const refPlaceholderCTC = useRef()
  const refPlaceholderWong = useRef()

  const [coloursDefault, setColoursDefault] = useState([])
  const [coloursExtended, setColoursExtended] = useState([])
  const [coloursCTC, setColoursCTC] = useState([])
  const [coloursWong, setColoursWong] = useState([])

  const [selectionColours, setSelectionColours] = useState(new Map())

  function onChangeTheme(theme) {
    setThemeInternal(theme)
    setTimeout(() => {
      updateSettings({ theme })
    }, 100)
  }

  function onChangeFontSizeDigits(value) {
    updateSettings({ fontSizeFactorDigits: value })
  }

  function onChangeFontSizeCornerMarks(value) {
    updateSettings({ fontSizeFactorCornerMarks: value })
  }

  function onChangeFontSizeCentreMarks(value) {
    updateSettings({ fontSizeFactorCentreMarks: value })
  }

  function fontSizeValueToDescription(value) {
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

  useEffect(() => {
    setThemeInternal(settings.theme)
  }, [settings.theme])

  useEffect(() => {
    function makeColours(elem) {
      let style = getComputedStyle(elem)
      let nColours = +style.getPropertyValue("--colors")
      let result = []
      for (let i = 0; i < nColours; ++i) {
        let pos = +style.getPropertyValue(`--color-${i + 1}-pos`)
        result[pos - 1] = style.getPropertyValue(`--color-${i + 1}`)
      }
      return result
    }

    setColoursDefault(makeColours(document.body))
    setColoursExtended(makeColours(refPlaceholderExtended.current))
    setColoursCTC(makeColours(refPlaceholderCTC.current))
    setColoursWong(makeColours(refPlaceholderWong.current))

    let style = getComputedStyle(refPlaceholderExtended.current)
    let selectionYellow = style.getPropertyValue("--selection-yellow")
    let selectionRed = style.getPropertyValue("--selection-red")
    let selectionGreen = style.getPropertyValue("--selection-green")
    let selectionBlue = style.getPropertyValue("--selection-blue")
    setSelectionColours(new Map([
      ["yellow", selectionYellow],
      ["red", selectionRed],
      ["green", selectionGreen],
      ["blue", selectionBlue]
    ]))
  }, [])

  return (<>
    <h2>Settings</h2>

    <h3>Theme</h3>
    <RadioGroup name="theme" value={themeInternal} options={[{
      id: "default",
      label: "Modern"
    }, {
      id: "ctc",
      label: "Cracking the Cryptic"
    }, {
      id: "dark",
      label: "Dark"
    }]} onChange={onChangeTheme} />

    <h3>Colour Palette</h3>
    <div className="palette-placeholder" data-colour-palette="extended" ref={refPlaceholderExtended} />
    <div className="palette-placeholder" data-colour-palette="ctc" ref={refPlaceholderCTC} />
    <div className="palette-placeholder" data-colour-palette="wong" ref={refPlaceholderWong} />
    <RadioGroup name="colourPalette" value={settings.colourPalette} options={[{
      id: "default",
      label: <div className="palette-label"><div>Modern</div>
        <Palette colours={coloursDefault} /></div>
    }, {
      id: "extended",
      label: <div className="palette-label"><div>Modern (extended)</div>
        <Palette colours={coloursExtended} /></div>
    }, {
      id: "ctc",
      label: <div className="palette-label"><div>Cracking the Cryptic</div>
        <Palette colours={coloursCTC} /></div>
    }, {
      id: "wong",
      label: <div className="palette-label"><div>Wong (optimised for colour-blindness)</div>
        <Palette colours={coloursWong} /></div>
    }]} onChange={(colourPalette) => updateSettings({ colourPalette })} />

    <h3>Selection colour</h3>
    <div className="selection-colours">
      {[...selectionColours.entries()].map(k => (
        <div key={k[0]} className={classNames("selection-colour", {
          active: k[0] === settings.selectionColour
        })} onClick={() => updateSettings({ selectionColour: k[0] })}>
          <div className="colour" style={{ backgroundColor: k[1] }}></div>
          {k[0] === settings.selectionColour && <div className="check"><Check size="1rem" /></div>}
        </div>
      ))}
    </div>

    <h3>Font sizes</h3>
    <div className="slider">
      <RangeSlider id="range-digits" label="Digits"
        min="0.75" max="1.5" step="0.125" value={settings.fontSizeFactorDigits}
        onChange={onChangeFontSizeDigits}
        valueToDescription={fontSizeValueToDescription} />
    </div>
    <div className="slider">
      <RangeSlider id="range-corner-marks" label="Corner marks"
        min="0.75" max="1.5" step="0.125" value={settings.fontSizeFactorCornerMarks}
        onChange={onChangeFontSizeCornerMarks}
        valueToDescription={fontSizeValueToDescription} />
    </div>
    <div className="slider">
      <RangeSlider id="range-centre-marks" label="Centre marks"
        min="0.75" max="1.5" step="0.125" value={settings.fontSizeFactorCentreMarks}
        onChange={onChangeFontSizeCentreMarks}
        valueToDescription={fontSizeValueToDescription} />
    </div>

    <style jsx>{styles}</style>
  </>)
}

export default Settings
