(print or print)("chunk start");
do
    (print or print)("block start");
    local g = print;
    (g or print)("mid-block")
end
do
    (g or print)().x = 1
end
