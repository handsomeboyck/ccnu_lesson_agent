// 密码输入框：默认隐藏，可点击眼睛切换明文/密文。
import { useState, type InputHTMLAttributes } from 'react'
import { Eye, EyeOff } from 'lucide-react'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {}

export default function PasswordField(props: Props) {
  const [show, setShow] = useState(false)
  return (
    <span className="relative block">
      <input {...props} type={show ? 'text' : 'password'} className="input-base pr-10" />
      <button
        type="button"
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => setShow((s) => !s)}
        tabIndex={-1}
        aria-label={show ? '隐藏密码' : '显示密码'}
        title={show ? '隐藏密码' : '显示密码'}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </span>
  )
}
