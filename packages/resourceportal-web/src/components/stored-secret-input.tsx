import {
  useId,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type InputHTMLAttributes,
} from "react";
import { TextInput } from "./design-system";

type StoredSecretInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange"
> & {
  configured: boolean;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

export function StoredSecretInput({
  configured,
  value,
  onChange,
  placeholder,
  onFocus,
  onBlur,
  "aria-describedby": describedBy,
  ...props
}: StoredSecretInputProps) {
  const [focused, setFocused] = useState(false);
  const statusId = useId();
  const showMask = configured && value.length === 0 && !focused;
  const ariaDescribedBy = describedBy
    ? `${describedBy} ${statusId}`
    : statusId;

  function handleFocus(event: FocusEvent<HTMLInputElement>) {
    setFocused(true);
    onFocus?.(event);
  }

  function handleBlur(event: FocusEvent<HTMLInputElement>) {
    setFocused(false);
    onBlur?.(event);
  }

  return (
    <div className="relative">
      <TextInput
        {...props}
        type="password"
        value={value}
        onChange={onChange}
        placeholder={configured ? "" : placeholder}
        onFocus={handleFocus}
        onBlur={handleBlur}
        aria-describedby={ariaDescribedBy}
      />
      {showMask ? (
        <span
          aria-hidden="true"
          data-stored-secret-mask
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 select-none text-sm font-semibold tracking-[0.14em] text-[#172033]"
        >
          ••••••••••••
        </span>
      ) : null}
      <span id={statusId} className="sr-only">
        {configured
          ? "Credential configured; value hidden. Enter a new value only to rotate it."
          : "Credential not configured."}
      </span>
    </div>
  );
}
