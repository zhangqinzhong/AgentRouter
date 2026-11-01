import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
// <button> in a comment is fine, so is a <ButtonGroup> or <selection-list>.
export function Toolbar() {
  return (
    <div>
      <Button size="sm" variant="ghost">Save</Button>
      <Select options={[{ label: "One", value: "one" }]} />
    </div>
  );
}
