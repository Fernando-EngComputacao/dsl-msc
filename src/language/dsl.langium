grammar MyDsl

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
terminal STRING: /"[^"]*"|'[^']*'/;

entry Model:
    elements+=Reservation*;

Reservation:
    'reserve' resource=ID 'at' time=STRING;
