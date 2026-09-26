"use client";

import { useState, useMemo } from "react";
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, List } from "lucide-react";
import Link from "next/link";
import RoundStatusBadge from "@/components/app/RoundStatusBadge";

const EVENT_TYPES = {
  opening: { label: "Opening", color: "bg-blue-500", textColor: "text-blue-500" },
  locking: { label: "Locking", color: "bg-yellow-500", textColor: "text-yellow-500" },
  drawing: { label: "Drawing", color: "bg-purple-500", textColor: "text-purple-500" },
  claiming: { label: "Claim Deadline", color: "bg-red-500", textColor: "text-red-500" },
};

function getPoolEvents(pool) {
  const events = [];
  
  if (pool.opensAt) {
    events.push({
      type: "opening",
      date: new Date(pool.opensAt),
      pool,
      label: `${pool.name} Opens`,
    });
  }
  
  if (pool.locksAt) {
    events.push({
      type: "locking",
      date: new Date(pool.locksAt),
      pool,
      label: `${pool.name} Locks`,
    });
  }
  
  if (pool.drawsAt) {
    events.push({
      type: "drawing",
      date: new Date(pool.drawsAt),
      pool,
      label: `${pool.name} Draw`,
    });
  }
  
  if (pool.claimDeadline) {
    events.push({
      type: "claiming",
      date: new Date(pool.claimDeadline),
      pool,
      label: `${pool.name} Claim Deadline`,
    });
  }
  
  return events;
}

function MonthView({ events, currentDate, onDateSelect }) {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - startDate.getDay());
  
  const days = [];
  const current = new Date(startDate);
  
  while (current <= lastDay || current.getDay() !== 0) {
    days.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  
  const eventsByDate = events.reduce((acc, event) => {
    const dateKey = event.date.toDateString();
    if (!acc[dateKey]) acc[dateKey] = [];
    acc[dateKey].push(event);
    return {};
  }, {});

  return (
    <div className="grid grid-cols-7 gap-1">
      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
        <div
          key={day}
          className="text-center text-xs font-semibold text-vault-muted py-2"
        >
          {day}
        </div>
      ))}
      
      {days.map((day, idx) => {
        const dateKey = day.toDateString();
        const dayEvents = eventsByDate[dateKey] || [];
        const isCurrentMonth = day.getMonth() === month;
        const isToday = day.toDateString() === new Date().toDateString();
        
        return (
          <button
            key={idx}
            onClick={() => dayEvents.length > 0 && onDateSelect(day, dayEvents)}
            className={`min-h-[80px] p-2 rounded-lg border transition-colors ${
              isCurrentMonth
                ? "bg-vault-surface border-vault-border hover:border-vault-accent"
                : "bg-vault-surface/30 border-transparent text-vault-muted"
            } ${isToday ? "ring-2 ring-vault-accent" : ""} ${
              dayEvents.length > 0 ? "cursor-pointer" : "cursor-default"
            }`}
          >
            <div className="text-sm font-medium mb-1">{day.getDate()}</div>
            <div className="space-y-0.5">
              {dayEvents.slice(0, 2).map((event, i) => (
                <div
                  key={i}
                  className={`text-[10px] px-1 py-0.5 rounded ${EVENT_TYPES[event.type].color} text-white truncate`}
                >
                  {event.pool.name}
                </div>
              ))}
              {dayEvents.length > 2 && (
                <div className="text-[9px] text-vault-muted">
                  +{dayEvents.length - 2} more
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function AgendaView({ events }) {
  const groupedEvents = useMemo(() => {
    const sorted = [...events].sort((a, b) => a.date - b.date);
    const groups = {};
    
    sorted.forEach((event) => {
      const dateKey = event.date.toDateString();
      if (!groups[dateKey]) {
        groups[dateKey] = {
          date: event.date,
          events: [],
        };
      }
      groups[dateKey].events.push(event);
    });
    
    return Object.values(groups);
  }, [events]);

  if (groupedEvents.length === 0) {
    return (
      <div className="text-center py-12 text-vault-muted">
        <CalendarIcon size={48} className="mx-auto mb-4 opacity-50" />
        <p>No upcoming events</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groupedEvents.map((group, idx) => (
        <div key={idx} className="vq-glass p-4">
          <div className="font-semibold text-vault-text mb-3 flex items-center gap-2">
            <CalendarIcon size={16} className="text-vault-accent" />
            {group.date.toLocaleDateString("en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </div>
          <div className="space-y-2">
            {group.events.map((event, i) => (
              <Link
                key={i}
                href={`/app/vaults/${event.pool.id}`}
                className="flex items-center justify-between p-3 rounded-lg bg-vault-surface hover:bg-vault-surface/80 transition-colors border border-vault-border hover:border-vault-accent"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-1 h-12 rounded-full ${EVENT_TYPES[event.type].color}`}
                  />
                  <div>
                    <p className="font-medium text-vault-text">{event.label}</p>
                    <p className="text-xs text-vault-muted mt-0.5">
                      {event.pool.asset} • {event.date.toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
                <RoundStatusBadge status={event.pool.status} />
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PoolCalendar({ pools }) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewMode, setViewMode] = useState("month");
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedEvents, setSelectedEvents] = useState([]);

  const allEvents = useMemo(() => {
    return pools.flatMap(getPoolEvents);
  }, [pools]);

  const handlePreviousMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  const handleDateSelect = (date, events) => {
    setSelectedDate(date);
    setSelectedEvents(events);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h3 className="text-xl font-bold text-vault-text">Pool Calendar</h3>
          {viewMode === "month" && (
            <div className="flex items-center gap-2">
              <button
                onClick={handlePreviousMonth}
                className="p-2 rounded-lg hover:bg-vault-surface transition-colors text-vault-muted hover:text-vault-text"
                aria-label="Previous month"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="font-medium text-vault-text min-w-[140px] text-center">
                {currentDate.toLocaleDateString("en-US", {
                  month: "long",
                  year: "numeric",
                })}
              </span>
              <button
                onClick={handleNextMonth}
                className="p-2 rounded-lg hover:bg-vault-surface transition-colors text-vault-muted hover:text-vault-text"
                aria-label="Next month"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </div>

        <div className="flex gap-2 rounded-lg border border-vault-border p-1 bg-vault-surface">
          <button
            onClick={() => setViewMode("month")}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              viewMode === "month"
                ? "bg-vault-accent/20 text-vault-accent"
                : "text-vault-muted hover:text-vault-text"
            }`}
          >
            <CalendarIcon size={14} className="inline mr-1" />
            Month
          </button>
          <button
            onClick={() => setViewMode("agenda")}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              viewMode === "agenda"
                ? "bg-vault-accent/20 text-vault-accent"
                : "text-vault-muted hover:text-vault-text"
            }`}
          >
            <List size={14} className="inline mr-1" />
            Agenda
          </button>
        </div>
      </div>

      <div className="vq-glass p-4">
        <div className="flex flex-wrap gap-4 mb-4 text-xs">
          {Object.entries(EVENT_TYPES).map(([key, { label, color, textColor }]) => (
            <div key={key} className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded ${color}`} />
              <span className={textColor}>{label}</span>
            </div>
          ))}
        </div>

        {viewMode === "month" ? (
          <MonthView
            events={allEvents}
            currentDate={currentDate}
            onDateSelect={handleDateSelect}
          />
        ) : (
          <AgendaView events={allEvents} />
        )}
      </div>

      {selectedDate && selectedEvents.length > 0 && (
        <div className="vq-glass p-4">
          <h4 className="font-semibold text-vault-text mb-3">
            Events on {selectedDate.toLocaleDateString("en-US", { month: "long", day: "numeric" })}
          </h4>
          <div className="space-y-2">
            {selectedEvents.map((event, i) => (
              <Link
                key={i}
                href={`/app/vaults/${event.pool.id}`}
                className="flex items-center justify-between p-3 rounded-lg bg-vault-surface hover:bg-vault-surface/80 transition-colors border border-vault-border hover:border-vault-accent"
              >
                <div>
                  <p className="font-medium text-vault-text">{event.label}</p>
                  <p className="text-xs text-vault-muted">{event.pool.asset}</p>
                </div>
                <span className={`text-xs ${EVENT_TYPES[event.type].textColor}`}>
                  {EVENT_TYPES[event.type].label}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
