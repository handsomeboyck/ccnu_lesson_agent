// 密码输入框：默认隐藏，可点击眼睛切换明文/密文。
import { useState, type InputHTMLAttributes } from 'react'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {}

export default function PasswordField(props: Props) {
  const [show, setShow] = useState(false)
  return (
    <span className="pass-wrap">
      <input {...props} type={show ? 'text' : 'password'} />
      <button
        type="button"
        className="pass-toggle"
        onClick={() => setShow((s) => !s)}
        tabIndex={-1}
        aria-label={show ? '隐藏密码' : '显示密码'}
        title={show ? '隐藏密码' : '显示密码'}
      >
        {show ? '🙈' : '👁️'}
      </button>
    </span>
  )
}
