import * as React from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { cn } from "@/lib/utils";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3 [&_.rdp-day_button]:h-9 [&_.rdp-day_button]:w-9", className)}
      classNames={{
        month_caption: "flex justify-center pt-1 relative items-center",
        chevron: "h-4 w-4",
        selected: "bg-primary text-primary-foreground [&_.rdp-day_button]:bg-primary",
        today: "[&_.rdp-day_button]:ring-2 [&_.rdp-day_button]:ring-primary",
        outside: "text-muted-foreground opacity-50",
        disabled: "text-muted-foreground opacity-50",
        ...classNames,
      }}
      {...props}
    />
  );
}
Calendar.displayName = "Calendar";

export { Calendar };