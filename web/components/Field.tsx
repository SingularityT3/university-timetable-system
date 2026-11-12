/** A labelled form control (label above the input/select). */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

/** Select over {id, label} options; ids may be numbers or strings. */
export function OptionSelect<Id extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: Id; label: string }[];
  value: Id | null;
  onChange: (id: Id) => void;
  label: string;
}) {
  return (
    <Field label={label}>
      <select
        value={value === null ? "" : String(value)}
        onChange={(e) => {
          const hit = options.find((o) => String(o.id) === e.target.value);
          if (hit) onChange(hit.id);
        }}
      >
        {options.map((o) => (
          <option key={String(o.id)} value={String(o.id)}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
