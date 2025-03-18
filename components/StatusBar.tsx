import Timer from "./Timer"
import { useGame } from "./hooks/useGame"
import { useSidebar } from "./hooks/useSidebar"
import { ID_ABOUT, ID_HELP, ID_RULES, ID_SETTINGS } from "./lib/SidebarTabs"
import { TYPE_CHECK } from "./lib/Actions"
import { BookOpen, CheckCircle, HelpCircle, Info, Sliders } from "lucide-react"

const StatusBar = () => {
  const { title, rules, solved, updateGame } = useGame(state => ({
    title: state.data.title,
    rules: state.data.rules,
    solved: state.solved,
    updateGame: state.updateGame,
  }))
  const onTabClick = useSidebar(state => state.onTabClick)

  const handleCheck = () => {
    updateGame({
      type: TYPE_CHECK,
    })
  }

  return (
    <div className="static flex justify-center items-center w-full bg-grey-700 text-fg text-[0.8rem] font-normal h-[var(--status-bar-height)] pt-[1px] portrait:justify-between portrait:py-0 portrait:px-4">
      <div className="flex items-center">
        <Timer solved={solved} />
        <div
          className="flex ml-2 cursor-pointer hover:text-primary"
          onClick={handleCheck}
          title="Check solution"
        >
          <CheckCircle height="1em" />
        </div>
      </div>
      <div className="portrait:flex hidden">
        {title !== undefined && rules !== undefined && (
          <div
            className="flex ml-2 cursor-pointer hover:text-primary"
            onClick={() => onTabClick(ID_RULES)}
          >
            <BookOpen height="1em" />
          </div>
        )}
        <div
          className="flex ml-2 cursor-pointer hover:text-primary"
          onClick={() => onTabClick(ID_SETTINGS)}
        >
          <Sliders height="1em" />
        </div>
        <div
          className="flex ml-2 cursor-pointer hover:text-primary"
          onClick={() => onTabClick(ID_HELP)}
        >
          <HelpCircle height="1em" />
        </div>
        <div
          className="flex ml-2 cursor-pointer hover:text-primary"
          onClick={() => onTabClick(ID_ABOUT)}
        >
          <Info height="1em" />
        </div>
      </div>
    </div>
  )
}

export default StatusBar
