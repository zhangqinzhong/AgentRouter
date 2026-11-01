// Expected: 3 native-control violations.
export function Toolbar() {
  return (
    <div>
      <button type="button">Save</button>
      <button
        onClick={() => undefined}
      >Reset</button>
      <select><option>One</option></select>
    </div>
  );
}
