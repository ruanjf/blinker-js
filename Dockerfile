FROM node:18.12.1

COPY . /app/source
WORKDIR /app/source
RUN npm i
RUN cd ./example && npm i
RUN ./node_modules/.bin/tsc -p ./

# COPY --from=build /app/source/dist /app/blinker-js
# COPY --from=build /app/source/node_modules /app/blinker-js/
# WORKDIR /app/blinker-js

CMD ["node", "dist/example/miot/example_miot_outlet.js"]